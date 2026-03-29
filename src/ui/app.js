// =============================================================================
// agent-comm — Dashboard client
//
// Rendering strategy:
//   - Full state snapshot on connect and every 2s via DB poll (type: "state")
//   - Client-side fingerprint comparison skips re-render when data unchanged
//   - Only re-renders DOM when state actually differs
// =============================================================================

(function () {
  'use strict';

  // DOM morphing helper: diff-patches children instead of replacing innerHTML.
  // Preserves focus, scroll, CSS transitions — only changed nodes are touched.
  function morph(el, newInnerHTML) {
    var wrap = document.createElement(el.tagName);
    wrap.innerHTML = newInnerHTML;
    morphdom(el, wrap, { childrenOnly: true });
  }

  var state = { agents: [], channels: [], messages: [], state: [], messageCount: 0, reactions: {} };
  var agentNameCache = {}; // id → name, survives agent purges
  var ws = null;
  var reconnectTimer = null;
  var loaded = false;

  // -----------------------------------------------------------------------
  // Theme
  // -----------------------------------------------------------------------

  function initTheme() {
    var saved = localStorage.getItem('agent-comm-theme') || 'light';
    document.body.className = 'theme-' + saved;
    updateThemeIcon(saved);
  }

  function toggleTheme() {
    var current = document.body.className.includes('dark') ? 'dark' : 'light';
    var next = current === 'dark' ? 'light' : 'dark';
    document.body.className = 'theme-' + next;
    localStorage.setItem('agent-comm-theme', next);
    updateThemeIcon(next);
  }

  function updateThemeIcon(theme) {
    var icon = document.querySelector('.theme-icon');
    if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  function connect() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host);

    ws.onopen = function () {
      setConnectionStatus('connected', 'Connected');
      clearTimeout(reconnectTimer);
    };

    ws.onmessage = function (event) {
      var data = JSON.parse(event.data);
      if (data.type === 'state') {
        handleFullState(data);
      } else if (data.type && data.data) {
        handleEvent(data);
      }
    };

    ws.onclose = function () {
      setConnectionStatus('disconnected', 'Disconnected');
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = function () {
      ws.close();
    };
  }

  function setConnectionStatus(cls, text) {
    var el = document.getElementById('conn-status');
    el.className = 'connection-status ' + cls;
    el.textContent = text;
  }

  // -----------------------------------------------------------------------
  // Full state (connect + explicit refresh only)
  // -----------------------------------------------------------------------

  // Fingerprint cache: skip re-renders when data hasn't changed
  var lastStateFingerprint = '';

  function quickFingerprint(data) {
    var msgs = data.messages || [];
    var agents = data.agents || [];
    var fp = (data.messageCount || msgs.length) + ':' + msgs.length + ':' + agents.length;
    // Include latest message ID and agent statuses for fine-grained change detection
    if (msgs.length > 0) fp += ':m' + msgs[0].id;
    for (var i = 0; i < agents.length; i++) {
      fp += ':' + agents[i].id + '.' + agents[i].status;
    }
    fp += '|' + (data.channels || []).length;
    fp += '|' + (data.state || []).length;
    fp += '|' + JSON.stringify(data.reactions || {});
    return fp;
  }

  function handleFullState(data) {
    if (!loaded) {
      loaded = true;
      var overlay = document.getElementById('loading-overlay');
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.addEventListener(
        'transitionend',
        function () {
          overlay.style.display = 'none';
        },
        { once: true },
      );
    }

    // Skip re-render if nothing changed
    var fp = quickFingerprint(data);
    if (fp === lastStateFingerprint) return;
    lastStateFingerprint = fp;

    state = data;
    state.messageCount = data.messageCount || data.messages.length;
    state.reactions = data.reactions || {};
    if (data.version) {
      document.getElementById('version').textContent = 'v' + data.version;
    }
    // Cache agent names so they survive purges
    (state.agents || []).forEach(function (a) {
      agentNameCache[a.id] = a.name;
    });
    render();
  }

  // -----------------------------------------------------------------------
  // Incremental event handling
  // -----------------------------------------------------------------------

  function handleEvent(data) {
    var type = data.type;
    var d = data.data || {};

    switch (type) {
      case 'agent:registered': {
        var agent = d.agent;
        if (!agent) break;
        agentNameCache[agent.id] = agent.name;
        var idx = indexById(state.agents, agent.id);
        if (idx >= 0) state.agents[idx] = agent;
        else state.agents.unshift(agent);
        renderAgents();
        renderOverview();
        updateNavBadges();
        showToast('Agent joined', agent.name + ' registered');
        break;
      }
      case 'agent:updated': {
        if (!d.agentId) break;
        var found = findById(state.agents, d.agentId);
        if (found) {
          if (d.status) found.status = d.status;
          if (d.capabilities) found.capabilities = d.capabilities;
          if ('status_text' in d) found.status_text = d.status_text;
        }
        renderAgents();
        renderOverview();
        updateNavBadges();
        break;
      }
      case 'agent:offline': {
        if (!d.agentId) break;
        var name = resolveAgentName(d.agentId);
        var a = findById(state.agents, d.agentId);
        if (a) a.status = 'offline';
        renderAgents();
        renderOverview();
        updateNavBadges();
        showToast('Agent left', name + ' went offline');
        break;
      }
      case 'message:sent': {
        var msg = d.message;
        if (!msg) break;
        // Only show public messages (channel or broadcast, not DMs)
        if (msg.channel_id === null && msg.to_agent !== null) break;
        // Avoid duplicates (e.g. after reconnect)
        if (indexById(state.messages, msg.id) >= 0) break;
        state.messages.unshift(msg);
        if (state.messages.length > 50) state.messages.length = 50;
        state.messageCount = (state.messageCount || 0) + 1;
        renderMessages();
        renderOverview();
        updateNavBadges();
        var preview = (msg.content || '').substring(0, 60);
        showToast('New message', resolveAgentName(msg.from_agent) + ': ' + preview);
        break;
      }
      case 'channel:created': {
        var ch = d.channel;
        if (!ch) break;
        var chIdx = indexById(state.channels, ch.id);
        if (chIdx >= 0)
          state.channels[chIdx] = ch; // update (e.g. description change)
        else state.channels.push(ch);
        renderChannels();
        updateNavBadges();
        break;
      }
      case 'channel:archived': {
        if (!d.channelId) break;
        var archivedCh = findById(state.channels, d.channelId);
        if (archivedCh) {
          archivedCh.archived_at = new Date().toISOString();
          if (!state._archivedChannels) state._archivedChannels = [];
          state._archivedChannels.push(archivedCh);
        }
        state.channels = state.channels.filter(function (c) {
          return c.id !== d.channelId;
        });
        renderChannels();
        updateNavBadges();
        break;
      }
      case 'state:changed': {
        if (!d.namespace || !d.key) break;
        var found2 = false;
        for (var si = 0; si < state.state.length; si++) {
          if (state.state[si].namespace === d.namespace && state.state[si].key === d.key) {
            state.state[si].value = d.value;
            state.state[si].updated_by = d.updated_by;
            state.state[si].updated_at = data.timestamp || new Date().toISOString();
            found2 = true;
            break;
          }
        }
        if (!found2) {
          state.state.push({
            namespace: d.namespace,
            key: d.key,
            value: d.value,
            updated_by: d.updated_by,
            updated_at: data.timestamp || new Date().toISOString(),
          });
        }
        renderState();
        break;
      }
      case 'state:deleted': {
        if (d.key) {
          state.state = state.state.filter(function (e) {
            return !(e.namespace === d.namespace && e.key === d.key);
          });
        } else if (d.namespace) {
          state.state = state.state.filter(function (e) {
            return e.namespace !== d.namespace;
          });
        }
        renderState();
        break;
      }
      case 'message:reacted': {
        if (!d.messageId || !d.reaction) break;
        if (!state.reactions[d.messageId]) state.reactions[d.messageId] = [];
        state.reactions[d.messageId].push({ agent_id: d.agentId, reaction: d.reaction });
        renderMessages();
        break;
      }
      case 'message:unreacted': {
        if (!d.messageId || !d.reaction) break;
        var rxns = state.reactions[d.messageId];
        if (rxns) {
          state.reactions[d.messageId] = rxns.filter(function (r) {
            return !(r.agent_id === d.agentId && r.reaction === d.reaction);
          });
        }
        renderMessages();
        break;
      }
      // message:read, message:acked, channel:member_joined/left — no visible UI change
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function indexById(arr, id) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) return i;
    }
    return -1;
  }

  function findById(arr, id) {
    var i = indexById(arr, id);
    return i >= 0 ? arr[i] : null;
  }

  function esc(str) {
    if (str === null || str === undefined) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function escAttr(str) {
    return esc(str).replace(/"/g, '&quot;');
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    var now = Date.now();
    var then = new Date(
      dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'),
    ).getTime();
    var seconds = Math.max(0, Math.floor((now - then) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  function resolveAgentName(id) {
    var agents = state.agents || [];
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].id === id) return agents[i].name;
    }
    if (agentNameCache[id]) return agentNameCache[id];
    return id ? id.substring(0, 8) : 'unknown';
  }

  function resolveChannelName(id) {
    var channels = state.channels || [];
    for (var i = 0; i < channels.length; i++) {
      if (channels[i].id === id) return '#' + channels[i].name;
    }
    var archived = state._archivedChannels || [];
    for (var j = 0; j < archived.length; j++) {
      if (archived[j].id === id) return '#' + archived[j].name;
    }
    return '#' + (id ? id.substring(0, 8) : 'channel');
  }

  function renderMd(text) {
    if (!text) return '';
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      try {
        return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
      } catch (e) {
        return esc(text);
      }
    }
    return esc(text);
  }

  function stripMd(text) {
    if (!text) return '';
    return text
      .replace(/```[\s\S]*?```/g, ' [code] ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/#{1,6}\s+/g, '')
      .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/^>\s+/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/^---+$/gm, '')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseCaps(a) {
    try {
      return typeof a.capabilities === 'string' ? JSON.parse(a.capabilities) : a.capabilities || [];
    } catch (e) {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  function render() {
    renderOverview();
    renderAgents();
    renderMessages();
    renderChannels();
    renderState();
    updateNavBadges();
  }

  function renderOverview() {
    var agents = state.agents || [];
    var channels = state.channels || [];
    var messages = state.messages || [];
    var stateEntries = state.state || [];

    var onlineAgents = agents.filter(function (a) {
      return a.status !== 'offline';
    });
    document.getElementById('stat-agents').textContent = onlineAgents.length;
    document.getElementById('stat-channels').textContent = channels.length;
    document.getElementById('stat-messages').textContent = state.messageCount || messages.length;
    document.getElementById('stat-state').textContent = stateEntries.length;

    var agentsHtml =
      agents.length === 0
        ? '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">link_off</span>No agents online<div class="empty-state-hint">Agents will appear when they register</div></div>'
        : agents
            .map(function (a) {
              var caps = parseCaps(a);
              return (
                '<div class="activity-item" data-agent-id="' +
                escAttr(a.id) +
                '">' +
                '<span class="status-dot ' +
                esc(a.status) +
                '" aria-label="' +
                escAttr(a.status) +
                '"></span>' +
                '<span class="from">' +
                esc(a.name) +
                '</span>' +
                (caps.length > 0
                  ? ' <span style="color:var(--text-dim);font-size:11px">' +
                    caps
                      .map(function (c) {
                        return esc(c);
                      })
                      .join(', ') +
                    '</span>'
                  : '') +
                '<span class="time">' +
                timeAgo(a.last_heartbeat) +
                '</span>' +
                '</div>'
              );
            })
            .join('');
    var agentsEl = document.getElementById('overview-agents');
    morph(agentsEl, agentsHtml);

    var activityHtml =
      messages.length === 0
        ? '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">forum</span>No recent activity</div>'
        : messages
            .slice(0, 15)
            .map(function (m) {
              var stripped = stripMd(m.content || '');
              var preview = stripped.substring(0, 80);
              if (stripped.length > 80) preview += '...';
              return (
                '<div class="activity-item" data-msg-id="' +
                m.id +
                '">' +
                '<span class="from">' +
                esc(resolveAgentName(m.from_agent)) +
                '</span> ' +
                '<span>' +
                esc(preview) +
                '</span>' +
                '<span class="time">' +
                timeAgo(m.created_at) +
                '</span>' +
                '</div>'
              );
            })
            .join('');
    var activityEl = document.getElementById('overview-activity');
    morph(activityEl, activityHtml);
  }

  function heartbeatFreshness(dateStr) {
    if (!dateStr) return { text: '', cls: '' };
    var now = Date.now();
    var then = new Date(
      dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'),
    ).getTime();
    var seconds = Math.max(0, Math.floor((now - then) / 1000));
    var text = timeAgo(dateStr);
    var cls = seconds < 30 ? 'hb-fresh' : seconds < 120 ? 'hb-warm' : 'hb-stale';
    return { text: text, cls: cls };
  }

  function buildAgentCard(a) {
    var caps = parseCaps(a);
    var msgCount = (state.messages || []).filter(function (m) {
      return m.from_agent === a.id || m.to_agent === a.id;
    }).length;
    var hb = heartbeatFreshness(a.last_heartbeat);
    return (
      '<div class="card-title"><span class="status-dot ' +
      esc(a.status) +
      '"></span>' +
      esc(a.name) +
      '</div>' +
      (a.status_text ? '<div class="card-meta status-text">' + esc(a.status_text) + '</div>' : '') +
      '<div class="card-meta">Status: ' +
      esc(a.status) +
      ' &middot; Heartbeat: <span class="' +
      hb.cls +
      '">' +
      hb.text +
      '</span></div>' +
      '<div class="card-meta">Registered: ' +
      timeAgo(a.registered_at) +
      '</div>' +
      (msgCount > 0 ? '<div class="card-meta">' + msgCount + ' messages</div>' : '') +
      '<div style="margin-top:8px">' +
      caps
        .map(function (c) {
          return '<span class="capability-tag">' + esc(c) + '</span>';
        })
        .join('') +
      '</div>' +
      '<div class="card-action">View messages &rarr;</div>'
    );
  }

  function renderAgents() {
    var agents = state.agents || [];
    var container = document.getElementById('agents-list');

    if (agents.length === 0) {
      morph(
        container,
        '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">smart_toy</span>No agents registered<div class="empty-state-hint">Use comm_register to connect an agent</div></div>',
      );
      return;
    }

    morph(
      container,
      agents
        .map(function (a) {
          return (
            '<div class="card agent-card" data-agent-id="' +
            escAttr(a.id) +
            '">' +
            buildAgentCard(a) +
            '</div>'
          );
        })
        .join(''),
    );
  }

  var selectedMessageId = null;
  var messageFilters = { agent: null, channel: null };

  function setMessageFilter(type, value) {
    messageFilters[type] = messageFilters[type] === value ? null : value;
    searchResults = null;
    var searchInput = document.getElementById('msg-search');
    if (searchInput) searchInput.value = '';
    location.hash = 'messages';
    switchView('messages');
    renderMessages();
  }

  var searchDebounce = null;
  var searchResults = null;

  function triggerSearch() {
    var searchInput = document.getElementById('msg-search');
    var query = (searchInput.value || '').trim();
    if (query.length < 2) {
      searchResults = null;
      renderMessages();
      return;
    }
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () {
      fetch('/api/search?q=' + encodeURIComponent(query) + '&limit=50')
        .then(function (r) {
          return r.json();
        })
        .then(function (results) {
          searchResults = results.map(function (r) {
            return r.message;
          });
          renderMessages();
        })
        .catch(function () {
          searchResults = null;
          renderMessages();
        });
    }, 300);
  }

  function renderMessages() {
    var messages = state.messages || [];
    var container = document.getElementById('messages-list');
    var detailPane = document.getElementById('message-detail');
    var searchInput = document.getElementById('msg-search');
    var query = (searchInput.value || '').trim();

    var filtered = searchResults !== null ? searchResults : messages;
    if (searchResults === null) {
      if (messageFilters.agent) {
        var agentId = messageFilters.agent;
        filtered = filtered.filter(function (m) {
          return m.from_agent === agentId || m.to_agent === agentId;
        });
      }
      if (messageFilters.channel) {
        var chId = messageFilters.channel;
        filtered = filtered.filter(function (m) {
          return m.channel_id === chId;
        });
      }
      if (query && query.length === 1) {
        var filter = query.toLowerCase();
        filtered = filtered.filter(function (m) {
          return (
            (m.content || '').toLowerCase().indexOf(filter) !== -1 ||
            resolveAgentName(m.from_agent).toLowerCase().indexOf(filter) !== -1
          );
        });
      }
    }

    var filtersEl = document.getElementById('msg-filters');
    if (filtersEl) {
      var chips = [];
      if (searchResults !== null) {
        chips.push(
          '<span class="filter-chip">FTS: ' +
            filtered.length +
            ' results <button class="chip-remove" data-clear="search">&times;</button></span>',
        );
      }
      if (messageFilters.agent) {
        chips.push(
          '<span class="filter-chip">Agent: ' +
            esc(resolveAgentName(messageFilters.agent)) +
            ' <button class="chip-remove" data-clear="agent">&times;</button></span>',
        );
      }
      if (messageFilters.channel) {
        chips.push(
          '<span class="filter-chip">Channel: ' +
            esc(resolveChannelName(messageFilters.channel)) +
            ' <button class="chip-remove" data-clear="channel">&times;</button></span>',
        );
      }
      filtersEl.innerHTML = chips.join('');
      filtersEl.querySelectorAll('.chip-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var key = this.getAttribute('data-clear');
          if (key === 'search') {
            searchResults = null;
            document.getElementById('msg-search').value = '';
          } else {
            messageFilters[key] = null;
          }
          renderMessages();
        });
      });
    }

    if (filtered.length === 0) {
      morph(
        container,
        '<div class="empty-state">' +
          (query || messageFilters.agent || messageFilters.channel || searchResults !== null
            ? 'No matching messages'
            : '<span class="material-symbols-outlined empty-state-icon">inbox</span>No messages yet') +
          '</div>',
      );
      if (detailPane)
        morph(
          detailPane,
          '<div class="detail-empty"><span class="material-symbols-outlined detail-empty-icon">mail</span><div>No messages</div></div>',
        );
      return;
    }

    var threadRoots = {};
    messages.forEach(function (m) {
      if (m.thread_id) {
        if (!threadRoots[m.thread_id]) threadRoots[m.thread_id] = [];
        threadRoots[m.thread_id].push(m);
      }
    });

    morph(
      container,
      filtered
        .map(function (m) {
          var fromName = resolveAgentName(m.from_agent);
          var toLabel = m.to_agent
            ? '&rarr; ' + esc(resolveAgentName(m.to_agent))
            : m.channel_id
              ? '&rarr; ' + esc(resolveChannelName(m.channel_id))
              : '';
          var isFwd = /--- Forwarded from .+ ---/.test(m.content || '');
          var rawPreview = stripMd(m.content || '');
          // For forwarded messages, show the original content as preview
          if (isFwd) {
            var fwdParts = (m.content || '').match(/--- Forwarded from .+ ---\n([\s\S]*)/);
            rawPreview = fwdParts ? stripMd(fwdParts[1]) : rawPreview;
          }
          var preview = rawPreview.substring(0, 80);
          if (rawPreview.length > 80) preview += '...';
          var replies = threadRoots[m.id] || [];
          var isSelected = selectedMessageId === m.id;

          return (
            '<div class="msg-compact no-anim' +
            (isSelected ? ' selected' : '') +
            '" data-msg-id="' +
            m.id +
            '">' +
            '<div class="msg-compact-header">' +
            '<span class="message-avatar">' +
            esc(fromName.substring(0, 2).toUpperCase()) +
            '</span>' +
            '<span class="msg-compact-from">' +
            esc(fromName) +
            '</span>' +
            '<span class="msg-compact-to">' +
            toLabel +
            '</span>' +
            '<span class="msg-compact-time">' +
            timeAgo(m.created_at) +
            '</span>' +
            '</div>' +
            '<div class="msg-compact-preview">' +
            esc(preview) +
            '</div>' +
            '<div class="msg-compact-badges">' +
            (m.importance && m.importance !== 'normal'
              ? '<span class="importance-badge importance-' +
                esc(m.importance) +
                '">' +
                esc(m.importance) +
                '</span>'
              : '') +
            (isFwd ? '<span class="message-tag fwd-tag">fwd</span>' : '') +
            (replies.length > 0
              ? '<span class="message-tag thread-count">' + replies.length + ' replies</span>'
              : '') +
            (m.thread_id ? '<span class="message-tag">reply</span>' : '') +
            (m.ack_required ? '<span class="message-tag ack-tag">ack</span>' : '') +
            ((state.reactions[m.id] || []).length > 0
              ? '<span class="message-tag reaction-tag">' +
                (state.reactions[m.id] || []).length +
                ' reactions</span>'
              : '') +
            '</div>' +
            '</div>'
          );
        })
        .join(''),
    );

    if (selectedMessageId) {
      renderMessageDetail(selectedMessageId, threadRoots);
    } else if (detailPane) {
      detailPane.innerHTML =
        '<div class="detail-empty"><span class="material-symbols-outlined detail-empty-icon">mail</span><div>Select a message to view details</div></div>';
    }
  }

  function renderMessageDetail(msgId, threadRoots) {
    var detailPane = document.getElementById('message-detail');
    if (!detailPane) return;

    var messages = state.messages || [];
    var msg = findById(messages, msgId);
    if (!msg) {
      detailPane.innerHTML =
        '<div class="detail-empty"><span class="material-symbols-outlined detail-empty-icon">mail</span><div>Message not found</div></div>';
      return;
    }

    var fromName = resolveAgentName(msg.from_agent);
    var toLabel = msg.to_agent
      ? 'To: ' + esc(resolveAgentName(msg.to_agent))
      : msg.channel_id
        ? 'In: ' + esc(resolveChannelName(msg.channel_id))
        : '';
    var replies = (threadRoots && threadRoots[msg.id]) || [];

    // Detect forwarded messages: content starts with optional comment then "--- Forwarded from X ---"
    var fwdMatch = (msg.content || '').match(/^([\s\S]*?)--- Forwarded from (.+?) ---\n([\s\S]*)$/);
    var fwdComment = fwdMatch ? fwdMatch[1].trim() : '';
    var fwdFrom = fwdMatch ? fwdMatch[2] : '';
    var fwdBody = fwdMatch ? fwdMatch[3] : '';
    var isForwarded = !!fwdMatch;

    var html =
      '<div class="detail-card">' +
      '<div class="detail-header">' +
      '<div class="detail-avatar">' +
      esc(fromName.substring(0, 2).toUpperCase()) +
      '</div>' +
      '<div class="detail-sender">' +
      '<div class="detail-sender-name">' +
      esc(fromName) +
      '</div>' +
      '<div class="detail-sender-meta">' +
      toLabel +
      ' &middot; ' +
      timeAgo(msg.created_at) +
      (msg.edited_at ? ' &middot; edited' : '') +
      '</div>' +
      '</div>' +
      '<div class="detail-badges">' +
      (isForwarded
        ? '<span class="message-tag fwd-tag"><span class="material-symbols-outlined" style="font-size:12px;vertical-align:-2px">forward_to_inbox</span> forwarded</span>'
        : '') +
      (msg.importance && msg.importance !== 'normal'
        ? '<span class="importance-badge importance-' +
          esc(msg.importance) +
          '">' +
          esc(msg.importance) +
          '</span>'
        : '') +
      (msg.ack_required ? '<span class="message-tag ack-tag">ack</span>' : '') +
      '</div>' +
      '</div>';

    // Show "In reply to" ABOVE the body for context
    if (msg.thread_id) {
      var parent = findById(messages, msg.thread_id);
      if (parent) {
        var parentPreview = stripMd(parent.content || '').substring(0, 120);
        if ((parent.content || '').length > 120) parentPreview += '...';
        html +=
          '<div class="detail-reply-context" data-goto-msg="' +
          parent.id +
          '">' +
          '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px;margin-right:4px;color:var(--text-dim)">reply</span>' +
          '<span class="reply-context-name">' +
          esc(resolveAgentName(parent.from_agent)) +
          '</span> ' +
          '<span class="reply-context-preview">' +
          esc(parentPreview) +
          '</span>' +
          '</div>';
      }
    }

    // Render body — special handling for forwarded messages
    if (isForwarded) {
      if (fwdComment) {
        html += '<div class="detail-body prose">' + renderMd(fwdComment) + '</div>';
      }
      html +=
        '<div class="forwarded-block">' +
        '<div class="forwarded-header"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px;margin-right:4px">forward_to_inbox</span>Forwarded from <strong>' +
        esc(fwdFrom) +
        '</strong></div>' +
        '<div class="forwarded-body prose">' +
        renderMd(fwdBody) +
        '</div>' +
        '</div>';
    } else {
      html += '<div class="detail-body prose">' + renderMd(msg.content) + '</div>';
    }

    // Reactions
    var msgReactions = state.reactions[msg.id] || [];
    if (msgReactions.length > 0) {
      var grouped = {};
      msgReactions.forEach(function (r) {
        if (!grouped[r.reaction]) grouped[r.reaction] = [];
        grouped[r.reaction].push(r.agent_id);
      });
      html += '<div class="detail-reactions">';
      Object.keys(grouped).forEach(function (reaction) {
        var agents = grouped[reaction].map(resolveAgentName).join(', ');
        html +=
          '<span class="reaction-badge" title="' +
          escAttr(agents) +
          '">' +
          esc(reaction) +
          ' <span class="reaction-count">' +
          grouped[reaction].length +
          '</span></span>';
      });
      html += '</div>';
    }

    if (replies.length > 0) {
      html +=
        '<div class="detail-thread">' +
        '<div class="detail-thread-title">Thread (' +
        replies.length +
        ' replies)</div>';
      replies.forEach(function (r) {
        var rName = resolveAgentName(r.from_agent);
        html +=
          '<div class="thread-msg" data-goto-msg="' +
          r.id +
          '">' +
          '<div class="thread-msg-avatar">' +
          esc(rName.substring(0, 2).toUpperCase()) +
          '</div>' +
          '<div class="thread-msg-content">' +
          '<div class="thread-msg-header">' +
          '<span class="thread-msg-name">' +
          esc(rName) +
          '</span>' +
          '<span class="thread-msg-time">' +
          timeAgo(r.created_at) +
          '</span>' +
          '</div>' +
          '<div class="thread-msg-body prose">' +
          renderMd(r.content) +
          '</div>' +
          '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    html += '</div>';

    // Wire up clickable navigation for reply context and thread messages
    detailPane.innerHTML = html;
    detailPane.querySelectorAll('[data-goto-msg]').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        var targetId = parseInt(this.getAttribute('data-goto-msg'), 10);
        selectedMessageId = targetId;
        renderMessages();
        var targetEl = document.querySelector('.msg-compact[data-msg-id="' + targetId + '"]');
        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  function buildChannelCard(ch) {
    var msgCount = (state.messages || []).filter(function (m) {
      return m.channel_id === ch.id;
    }).length;
    return (
      '<div class="card-title">#' +
      esc(ch.name) +
      '</div>' +
      (ch.description ? '<div class="card-meta">' + esc(ch.description) + '</div>' : '') +
      '<div class="card-meta">Created: ' +
      timeAgo(ch.created_at) +
      '</div>' +
      '<div class="card-meta">' +
      msgCount +
      ' messages</div>' +
      (ch.archived_at ? '<div class="card-meta" style="color:var(--yellow)">Archived</div>' : '') +
      '<div class="card-action">View messages &rarr;</div>'
    );
  }

  function renderChannels() {
    var channels = state.channels || [];
    var container = document.getElementById('channels-list');

    if (channels.length === 0) {
      morph(
        container,
        '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">forum</span>No channels created<div class="empty-state-hint">Use comm_channel_create to add a channel</div></div>',
      );
      return;
    }

    morph(
      container,
      channels
        .map(function (ch) {
          return (
            '<div class="card" data-channel-id="' +
            escAttr(ch.id) +
            '">' +
            buildChannelCard(ch) +
            '</div>'
          );
        })
        .join(''),
    );
  }

  function renderState() {
    var entries = state.state || [];
    var tbody = document.getElementById('state-tbody');
    var filterInput = document.getElementById('state-filter');
    var filter = (filterInput.value || '').toLowerCase();

    var filtered = entries;
    if (filter) {
      filtered = entries.filter(function (e) {
        return (
          e.key.toLowerCase().indexOf(filter) !== -1 ||
          e.namespace.toLowerCase().indexOf(filter) !== -1
        );
      });
    }

    if (filtered.length === 0) {
      morph(
        tbody,
        '<tr><td colspan="5" class="empty-state">' +
          (filter
            ? 'No matching entries'
            : '<span class="material-symbols-outlined empty-state-icon">database</span>No shared state') +
          '</td></tr>',
      );
      return;
    }

    morph(
      tbody,
      filtered
        .map(function (e) {
          return (
            '<tr>' +
            '<td>' +
            esc(e.namespace) +
            '</td>' +
            '<td>' +
            esc(e.key) +
            '</td>' +
            '<td class="value-cell" title="' +
            escAttr(e.value) +
            '">' +
            esc(e.value) +
            '</td>' +
            '<td>' +
            esc(resolveAgentName(e.updated_by)) +
            '</td>' +
            '<td>' +
            timeAgo(e.updated_at) +
            '</td>' +
            '</tr>'
          );
        })
        .join(''),
    );
  }

  // -----------------------------------------------------------------------
  // Nav badges
  // -----------------------------------------------------------------------

  function updateNavBadges() {
    var channels = state.channels || [];
    var stateEntries = state.state || [];
    var onlineCount = (state.agents || []).filter(function (a) {
      return a.status !== 'offline';
    }).length;

    setBadge('tab-agents', onlineCount);
    setBadge('tab-messages', state.messageCount || (state.messages || []).length);
    setBadge('tab-channels', channels.length);
    setBadge('tab-state', stateEntries.length);
  }

  function setBadge(tabId, count) {
    var tab = document.getElementById(tabId);
    if (!tab) return;
    var badge = tab.querySelector('.nav-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      tab.appendChild(badge);
    }
    badge.textContent = count;
    badge.className = 'nav-badge' + (count === 0 ? ' zero' : '');
  }

  // -----------------------------------------------------------------------
  // Toast notifications
  // -----------------------------------------------------------------------

  function showToast(title, body) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML =
      '<div class="toast-title">' +
      esc(title) +
      '</div><div class="toast-body">' +
      esc(body) +
      '</div>';
    container.appendChild(toast);
    setTimeout(function () {
      toast.classList.add('fade-out');
      setTimeout(function () {
        toast.remove();
      }, 300);
    }, 4000);
  }

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  function switchView(viewName) {
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.remove('active');
    });
    document.querySelectorAll('.nav-link').forEach(function (l) {
      l.classList.remove('active');
      l.setAttribute('aria-selected', 'false');
      l.setAttribute('tabindex', '-1');
    });

    var view = document.getElementById('view-' + viewName);
    var link = document.querySelector('[data-view="' + viewName + '"]');
    if (view) view.classList.add('active');
    if (link) {
      link.classList.add('active');
      link.setAttribute('aria-selected', 'true');
      link.setAttribute('tabindex', '0');
    }

    if (viewName !== 'channels') {
      var detail = document.getElementById('channel-detail');
      if (detail) {
        detail.hidden = true;
        detail.style.display = '';
      }
    }
  }

  function handleHash() {
    var hash = location.hash.replace('#', '') || 'overview';
    switchView(hash);
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  initTheme();

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Overview actions
  var cleanupBtn = document.getElementById('overview-cleanup');
  var cleanupModal = document.getElementById('cleanup-modal');

  function openCleanupModal() {
    cleanupModal.classList.remove('hidden');
  }

  function closeCleanupModal() {
    cleanupModal.classList.add('hidden');
  }

  function refreshAfterCleanup() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'refresh' }));
    }
  }

  function formatCleanupStats(s) {
    var parts = [];
    if (s.agents) parts.push(s.agents + ' agent(s)');
    if (s.messages) parts.push(s.messages + ' message(s)');
    if (s.channels) parts.push(s.channels + ' channel(s)');
    if (s.state) parts.push(s.state + ' state');
    return parts.length ? parts.join(', ') : 'nothing to clean';
  }

  if (cleanupBtn) {
    cleanupBtn.addEventListener('click', openCleanupModal);
  }

  document.getElementById('cleanup-cancel').addEventListener('click', closeCleanupModal);

  cleanupModal.addEventListener('click', function (e) {
    if (e.target === cleanupModal) closeCleanupModal();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !cleanupModal.classList.contains('hidden')) {
      closeCleanupModal();
    }
  });

  function runCleanup(endpoint, label) {
    closeCleanupModal();
    fetch(endpoint, { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (data) {
        showToast(label, formatCleanupStats(data));
        refreshAfterCleanup();
      })
      .catch(function () {
        showToast('Error', label + ' failed');
      });
  }

  document.getElementById('cleanup-stale').addEventListener('click', function () {
    runCleanup('/api/cleanup/stale', 'Stale cleanup');
  });

  document.getElementById('cleanup-full').addEventListener('click', function () {
    runCleanup('/api/cleanup/full', 'Full cleanup');
  });

  var refreshBtn = document.getElementById('overview-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'refresh' }));
        showToast('Refreshed', 'Dashboard data reloaded');
      }
    });
  }

  document.querySelectorAll('.stat-card-link').forEach(function (card) {
    card.addEventListener('click', function () {
      var target = card.getAttribute('data-nav');
      if (target) switchView(target);
    });
  });

  // Sidebar toggle (mobile)
  var sidebarToggle = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  var sidebarOverlay = document.getElementById('sidebar-overlay');

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', function () {
      var isOpen = sidebar.classList.toggle('open');
      sidebarOverlay.classList.toggle('open', isOpen);
      sidebarToggle.setAttribute('aria-expanded', String(isOpen));
    });
  }
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', function () {
      sidebar.classList.remove('open');
      sidebarOverlay.classList.remove('open');
      sidebarToggle.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebar && sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
      if (sidebarOverlay) sidebarOverlay.classList.remove('open');
      if (sidebarToggle) {
        sidebarToggle.setAttribute('aria-expanded', 'false');
        sidebarToggle.focus();
      }
    }
  });

  document.querySelectorAll('.nav-link').forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var view = this.getAttribute('data-view');
      location.hash = view;
      switchView(view);
      if (sidebar) sidebar.classList.remove('open');
      if (sidebarOverlay) sidebarOverlay.classList.remove('open');
      if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', 'false');
    });
    link.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.click();
      }
      var links = Array.from(document.querySelectorAll('.nav-link'));
      var idx = links.indexOf(this);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        var next = links[(idx + 1) % links.length];
        next.focus();
        next.click();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var prev = links[(idx - 1 + links.length) % links.length];
        prev.focus();
        prev.click();
      }
    });
  });

  document.getElementById('msg-search').addEventListener('input', triggerSearch);
  document.getElementById('state-filter').addEventListener('input', renderState);

  var clearMsgsBtn = document.getElementById('msg-clear');
  if (clearMsgsBtn) {
    clearMsgsBtn.addEventListener('click', function () {
      if (!confirm('Clear all messages? This cannot be undone.')) return;
      fetch('/api/messages', { method: 'DELETE' })
        .then(function () {
          state.messages = [];
          state.messageCount = 0;
          render();
          showToast('Cleared', 'All messages purged');
        })
        .catch(function () {
          showToast('Error', 'Failed to clear messages');
        });
    });
  }

  document.getElementById('messages-list').addEventListener('click', function (e) {
    var item = e.target.closest('.msg-compact[data-msg-id]');
    if (!item) return;
    var msgId = parseInt(item.getAttribute('data-msg-id'), 10);
    selectedMessageId = msgId;

    var container = document.getElementById('messages-list');
    container.querySelectorAll('.msg-compact.selected').forEach(function (el) {
      el.classList.remove('selected');
    });
    item.classList.add('selected');

    var messages = state.messages || [];
    var threadRoots = {};
    messages.forEach(function (m) {
      if (m.thread_id) {
        if (!threadRoots[m.thread_id]) threadRoots[m.thread_id] = [];
        threadRoots[m.thread_id].push(m);
      }
    });
    renderMessageDetail(msgId, threadRoots);
  });

  // Event delegation for morphdom-managed containers (listeners survive DOM diffs)
  document.getElementById('agents-list').addEventListener('click', function (e) {
    var card = e.target.closest('.agent-card[data-agent-id]');
    if (card) setMessageFilter('agent', card.getAttribute('data-agent-id'));
  });
  document.getElementById('channels-list').addEventListener('click', function (e) {
    var card = e.target.closest('[data-channel-id]');
    if (card) setMessageFilter('channel', card.getAttribute('data-channel-id'));
  });
  document.getElementById('overview-agents').addEventListener('click', function (e) {
    var el = e.target.closest('[data-agent-id]');
    if (el) setMessageFilter('agent', el.getAttribute('data-agent-id'));
  });
  document.getElementById('overview-activity').addEventListener('click', function (e) {
    var el = e.target.closest('[data-msg-id]');
    if (!el) return;
    var msgId = parseInt(el.getAttribute('data-msg-id'), 10);
    selectedMessageId = msgId;
    messageFilters.agent = null;
    messageFilters.channel = null;
    location.hash = 'messages';
    switchView('messages');
    renderMessages();
    setTimeout(function () {
      var target = document.querySelector('.msg-compact[data-msg-id="' + msgId + '"]');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  });

  window.addEventListener('hashchange', handleHash);
  handleHash();
  connect();

  // ---------------------------------------------------------------------------
  // Theme sync from parent (agent-desk) via executeJavaScript
  // ---------------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'theme-sync') return;
    var colors = event.data.colors;
    if (!colors) return;

    // Contrast enforcement: ensure text is readable against background
    function ensureContrast(bg, fg) {
      var lum = function (hex) {
        if (!hex || hex.charAt(0) !== '#' || hex.length < 7) return 0.5;
        var r = parseInt(hex.slice(1, 3), 16) / 255;
        var g = parseInt(hex.slice(3, 5), 16) / 255;
        var b = parseInt(hex.slice(5, 7), 16) / 255;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      var bgLum = lum(bg);
      return bgLum < 0.5 ? (lum(fg) < 0.4 ? '#e0e0e0' : fg) : lum(fg) > 0.6 ? '#333333' : fg;
    }

    var root = document.documentElement;
    var bgColor = colors.bg || null;

    // Core backgrounds
    if (colors.bg) root.style.setProperty('--bg', colors.bg);
    if (colors.bgSurface) root.style.setProperty('--bg-surface', colors.bgSurface);
    if (colors.bgElevated) root.style.setProperty('--bg-elevated', colors.bgElevated);
    if (colors.bgHover) root.style.setProperty('--bg-hover', colors.bgHover);

    // Borders
    if (colors.border) root.style.setProperty('--border', colors.border);
    if (colors.borderLight) root.style.setProperty('--border-light', colors.borderLight);

    // Text colors (with contrast enforcement)
    if (colors.text)
      root.style.setProperty(
        '--text',
        bgColor ? ensureContrast(bgColor, colors.text) : colors.text,
      );
    if (colors.textMuted)
      root.style.setProperty(
        '--text-muted',
        bgColor ? ensureContrast(bgColor, colors.textMuted) : colors.textMuted,
      );
    if (colors.textDim)
      root.style.setProperty(
        '--text-dim',
        bgColor ? ensureContrast(bgColor, colors.textDim) : colors.textDim,
      );

    // Accent colors
    if (colors.accent) root.style.setProperty('--accent', colors.accent);
    if (colors.accentDim) root.style.setProperty('--accent-dim', colors.accentDim);

    // Semantic colors
    if (colors.green) root.style.setProperty('--green', colors.green);
    if (colors.yellow) root.style.setProperty('--yellow', colors.yellow);
    if (colors.orange) root.style.setProperty('--orange', colors.orange);
    if (colors.red) root.style.setProperty('--red', colors.red);
    if (colors.purple) root.style.setProperty('--purple', colors.purple);

    // Focus ring
    if (colors.focusRing) root.style.setProperty('--focus-ring', colors.focusRing);

    // Shadows (adapt for dark/light)
    if (colors.isDark !== undefined) {
      if (colors.isDark) {
        root.style.setProperty(
          '--shadow-1',
          '0px 1px 2px 0px rgba(0,0,0,0.6), 0px 1px 3px 1px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-2',
          '0px 1px 2px 0px rgba(0,0,0,0.6), 0px 2px 6px 2px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-3',
          '0px 1px 3px 0px rgba(0,0,0,0.6), 0px 4px 8px 3px rgba(0,0,0,0.3)',
        );
      } else {
        root.style.setProperty(
          '--shadow-1',
          '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 1px 3px 1px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-2',
          '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 2px 6px 2px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-3',
          '0px 1px 3px 0px rgba(0,0,0,0.3), 0px 4px 8px 3px rgba(0,0,0,0.15)',
        );
      }
      root.style.setProperty('--shadow-sm', 'var(--shadow-1)');
      root.style.setProperty('--shadow-md', 'var(--shadow-2)');
      root.style.setProperty('--shadow-hover', 'var(--shadow-3)');
    }

    // Apply theme class and hide the toggle (agent-desk controls the theme)
    if (colors.isDark !== undefined) {
      document.body.className =
        document.body.className.replace(/theme-\w+/, '').trim() +
        ' theme-' +
        (colors.isDark ? 'dark' : 'light');
      localStorage.setItem('agent-comm-theme', colors.isDark ? 'dark' : 'light');
      updateThemeIcon(colors.isDark ? 'dark' : 'light');
    }

    // Hide the local theme toggle — agent-desk controls the theme
    var themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) themeToggle.style.display = 'none';
  });
})();
