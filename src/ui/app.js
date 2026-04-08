// =============================================================================
// agent-comm — Dashboard client
//
// Rendering strategy:
//   - Full state snapshot on connect and every 2s via DB poll (type: "state")
//   - Client-side fingerprint comparison skips re-render when data unchanged
//   - Only re-renders DOM when state actually differs
//
// Modules (loaded via script tags before this file):
//   ui-utils.js        — morph, esc, escAttr, timeAgo, renderMd, stripMd, etc.
//   render-agents.js   — renderAgents
//   render-messages.js — renderMessages, setMessageFilter, triggerSearch
//   render-channels.js — renderChannels
//   render-state.js    — renderState
//   render-feed.js     — renderFeed
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  // -----------------------------------------------------------------------
  // Shared state (readable by all modules via AC.state / AC.agentNameCache)
  // -----------------------------------------------------------------------

  AC.state = {
    agents: [],
    channels: [],
    messages: [],
    state: [],
    messageCount: 0,

    feed: [],
    branches: [],
  };
  AC.agentNameCache = {}; // id -> name, survives agent purges

  // -----------------------------------------------------------------------
  // Plugin support — configurable fetch proxy and WebSocket URL
  // -----------------------------------------------------------------------

  AC._baseUrl = '';
  AC._fetch = function (url, opts) {
    return fetch(AC._baseUrl + url, opts);
  };
  AC._wsUrl = null;
  AC._root = document;

  var ws = null;
  var reconnectTimer = null;
  var loaded = false;

  // -----------------------------------------------------------------------
  // Theme
  // -----------------------------------------------------------------------

  function initTheme() {
    var saved = localStorage.getItem('agent-comm-theme') || 'light';
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    updateThemeIcon(saved);
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var next = current === 'dark' ? 'light' : 'dark';
    if (next === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('agent-comm-theme', next);
    updateThemeIcon(next);
  }

  function updateThemeIcon(theme) {
    var icon = AC._root.querySelector('.theme-icon');
    if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  function connect() {
    var host = AC._wsUrl || location.host;
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + host);

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
    var el = AC._root.getElementById('conn-status');
    el.className = 'connection-status ' + cls;
    el.textContent = text;
  }

  // -----------------------------------------------------------------------
  // Full state (connect + explicit refresh only)
  // -----------------------------------------------------------------------

  var lastStateFingerprint = '';

  function quickFingerprint(data) {
    var msgs = data.messages || [];
    var agents = data.agents || [];
    var fp = (data.messageCount || msgs.length) + ':' + msgs.length + ':' + agents.length;
    if (msgs.length > 0) fp += ':m' + msgs[0].id;
    for (var i = 0; i < agents.length; i++) {
      fp += ':' + agents[i].id + '.' + agents[i].status;
    }
    fp += '|' + (data.channels || []).length;
    fp += '|' + (data.state || []).length;
    fp += '|' + (data.feed || []).length;
    if ((data.feed || []).length > 0) fp += ':f' + data.feed[0].id;
    fp += '|' + (data.branches || []).length;
    return fp;
  }

  function handleFullState(data) {
    if (!loaded) {
      loaded = true;
      var overlay = AC._root.getElementById('loading-overlay');
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

    if (data.delta) {
      Object.keys(data).forEach(function (k) {
        if (k !== 'type' && k !== 'delta') AC.state[k] = data[k];
      });
    } else {
      AC.state = data;
    }
    AC.state.messageCount = AC.state.messageCount || (AC.state.messages || []).length;
    if (!AC.state.feed) AC.state.feed = [];
    if (!AC.state.branches) AC.state.branches = [];

    var fp = quickFingerprint(AC.state);
    if (fp === lastStateFingerprint) return;
    lastStateFingerprint = fp;
    if (data.version) {
      AC._root.getElementById('version').textContent = 'v' + data.version;
    }
    (AC.state.agents || []).forEach(function (a) {
      AC.agentNameCache[a.id] = a.name;
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
        AC.agentNameCache[agent.id] = agent.name;
        var idx = AC.indexById(AC.state.agents, agent.id);
        if (idx >= 0) AC.state.agents[idx] = agent;
        else AC.state.agents.unshift(agent);
        AC.renderAgents();
        renderOverview();
        updateNavBadges();
        showToast('Agent joined', agent.name + ' registered');
        break;
      }
      case 'agent:updated': {
        if (!d.agentId) break;
        var found = AC.findById(AC.state.agents, d.agentId);
        if (found) {
          if (d.status) found.status = d.status;
          if (d.capabilities) found.capabilities = d.capabilities;
          if ('status_text' in d) found.status_text = d.status_text;
        }
        AC.renderAgents();
        renderOverview();
        updateNavBadges();
        break;
      }
      case 'agent:offline': {
        if (!d.agentId) break;
        var name = AC.resolveAgentName(d.agentId);
        var a = AC.findById(AC.state.agents, d.agentId);
        if (a) a.status = 'offline';
        AC.renderAgents();
        renderOverview();
        updateNavBadges();
        showToast('Agent left', name + ' went offline');
        break;
      }
      case 'message:sent': {
        var msg = d.message;
        if (!msg) break;
        if (msg.channel_id === null && msg.to_agent !== null) break;
        if (AC.indexById(AC.state.messages, msg.id) >= 0) break;
        AC.state.messages.unshift(msg);
        if (AC.state.messages.length > 50) AC.state.messages.length = 50;
        AC.state.messageCount = (AC.state.messageCount || 0) + 1;
        AC.renderMessages();
        renderOverview();
        updateNavBadges();
        var preview = (msg.content || '').substring(0, 60);
        showToast('New message', AC.resolveAgentName(msg.from_agent) + ': ' + preview);
        break;
      }
      case 'channel:created': {
        var ch = d.channel;
        if (!ch) break;
        var chIdx = AC.indexById(AC.state.channels, ch.id);
        if (chIdx >= 0) AC.state.channels[chIdx] = ch;
        else AC.state.channels.push(ch);
        AC.renderChannels();
        updateNavBadges();
        break;
      }
      case 'channel:archived': {
        if (!d.channelId) break;
        var archivedCh = AC.findById(AC.state.channels, d.channelId);
        if (archivedCh) {
          archivedCh.archived_at = new Date().toISOString();
          if (!AC.state._archivedChannels) AC.state._archivedChannels = [];
          AC.state._archivedChannels.push(archivedCh);
        }
        AC.state.channels = AC.state.channels.filter(function (c) {
          return c.id !== d.channelId;
        });
        AC.renderChannels();
        updateNavBadges();
        break;
      }
      case 'state:changed': {
        if (!d.namespace || !d.key) break;
        var found2 = false;
        for (var si = 0; si < AC.state.state.length; si++) {
          if (AC.state.state[si].namespace === d.namespace && AC.state.state[si].key === d.key) {
            AC.state.state[si].value = d.value;
            AC.state.state[si].updated_by = d.updated_by;
            AC.state.state[si].updated_at = data.timestamp || new Date().toISOString();
            found2 = true;
            break;
          }
        }
        if (!found2) {
          AC.state.state.push({
            namespace: d.namespace,
            key: d.key,
            value: d.value,
            updated_by: d.updated_by,
            updated_at: data.timestamp || new Date().toISOString(),
          });
        }
        AC.renderState();
        break;
      }
      case 'state:deleted': {
        if (d.key) {
          AC.state.state = AC.state.state.filter(function (e) {
            return !(e.namespace === d.namespace && e.key === d.key);
          });
        } else if (d.namespace) {
          AC.state.state = AC.state.state.filter(function (e) {
            return e.namespace !== d.namespace;
          });
        }
        AC.renderState();
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Rendering orchestration
  // -----------------------------------------------------------------------

  function render() {
    renderOverview();
    AC.renderAgents();
    AC.renderMessages();
    AC.renderChannels();
    AC.renderState();
    AC.renderFeed();
    updateNavBadges();
  }

  function renderOverview() {
    var agents = AC.state.agents || [];
    var channels = AC.state.channels || [];
    var messages = AC.state.messages || [];
    var stateEntries = AC.state.state || [];

    var onlineAgents = agents.filter(function (a) {
      return a.status !== 'offline';
    });
    AC._root.getElementById('stat-agents').textContent = onlineAgents.length;
    AC._root.getElementById('stat-channels').textContent = channels.length;
    AC._root.getElementById('stat-messages').textContent = AC.state.messageCount || messages.length;
    AC._root.getElementById('stat-state').textContent = stateEntries.length;

    var agentsHtml =
      agents.length === 0
        ? '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">link_off</span>No agents online<div class="empty-state-hint">Agents will appear when they register</div></div>'
        : agents
            .map(function (a) {
              var caps = AC.parseCaps(a);
              return (
                '<div class="activity-item" data-agent-id="' +
                AC.escAttr(a.id) +
                '">' +
                '<span class="status-dot ' +
                AC.esc(a.status) +
                '" aria-label="' +
                AC.escAttr(a.status) +
                '"></span>' +
                '<span class="from">' +
                AC.esc(a.name) +
                '</span>' +
                (caps.length > 0
                  ? ' <span style="color:var(--text-dim);font-size:11px">' +
                    caps
                      .map(function (c) {
                        return AC.esc(c);
                      })
                      .join(', ') +
                    '</span>'
                  : '') +
                '<span class="time">' +
                AC.timeAgo(a.last_heartbeat) +
                '</span>' +
                '</div>'
              );
            })
            .join('');
    var agentsEl = AC._root.getElementById('overview-agents');
    AC.morph(agentsEl, agentsHtml);

    var activityHtml =
      messages.length === 0
        ? '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">forum</span>No recent activity</div>'
        : messages
            .slice(0, 15)
            .map(function (m) {
              var stripped = AC.stripMd(m.content || '');
              var preview = stripped.substring(0, 80);
              if (stripped.length > 80) preview += '...';
              return (
                '<div class="activity-item" data-msg-id="' +
                m.id +
                '">' +
                '<span class="from">' +
                AC.esc(AC.resolveAgentName(m.from_agent)) +
                '</span> ' +
                '<span>' +
                AC.esc(preview) +
                '</span>' +
                '<span class="time">' +
                AC.timeAgo(m.created_at) +
                '</span>' +
                '</div>'
              );
            })
            .join('');
    var activityEl = AC._root.getElementById('overview-activity');
    AC.morph(activityEl, activityHtml);
  }

  // -----------------------------------------------------------------------
  // Nav badges
  // -----------------------------------------------------------------------

  function updateNavBadges() {
    var channels = AC.state.channels || [];
    var stateEntries = AC.state.state || [];
    var onlineCount = (AC.state.agents || []).filter(function (a) {
      return a.status !== 'offline';
    }).length;

    setBadge('tab-agents', onlineCount);
    setBadge('tab-messages', AC.state.messageCount || (AC.state.messages || []).length);
    setBadge('tab-channels', channels.length);
    setBadge('tab-state', stateEntries.length);
    setBadge('tab-feed', (AC.state.feed || []).length);
  }

  function setBadge(tabId, count) {
    var tab = AC._root.getElementById(tabId);
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
    var container = AC._root.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML =
      '<div class="toast-title">' +
      AC.esc(title) +
      '</div><div class="toast-body">' +
      AC.esc(body) +
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
    AC._root.querySelectorAll('.view').forEach(function (v) {
      v.classList.remove('active');
    });
    AC._root.querySelectorAll('.nav-link').forEach(function (l) {
      l.classList.remove('active');
      l.setAttribute('aria-selected', 'false');
      l.setAttribute('tabindex', '-1');
    });

    var view = AC._root.getElementById('view-' + viewName);
    var link = AC._root.querySelector('[data-view="' + viewName + '"]');
    if (view) view.classList.add('active');
    if (link) {
      link.classList.add('active');
      link.setAttribute('aria-selected', 'true');
      link.setAttribute('tabindex', '0');
    }

    if (viewName !== 'channels') {
      var detail = AC._root.getElementById('channel-detail');
      if (detail) {
        detail.hidden = true;
        detail.style.display = '';
      }
    }
  }

  // Export switchView so render-messages can use it
  AC.switchView = switchView;

  function handleHash() {
    var hash = location.hash.replace('#', '') || 'overview';
    switchView(hash);
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  function _init() {
    initTheme();

    AC._root.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // Overview actions
    var cleanupBtn = AC._root.getElementById('overview-cleanup');
    var cleanupModal = AC._root.getElementById('cleanup-modal');

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

    AC._root.getElementById('cleanup-cancel').addEventListener('click', closeCleanupModal);

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
      AC._fetch(endpoint, { method: 'POST' })
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

    AC._root.getElementById('cleanup-stale').addEventListener('click', function () {
      runCleanup('/api/cleanup/stale', 'Stale cleanup');
    });

    AC._root.getElementById('cleanup-full').addEventListener('click', function () {
      runCleanup('/api/cleanup/full', 'Full cleanup');
    });

    var refreshBtn = AC._root.getElementById('overview-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'refresh' }));
          showToast('Refreshed', 'Dashboard data reloaded');
        }
      });
    }

    AC._root.querySelectorAll('.stat-card-link').forEach(function (card) {
      card.addEventListener('click', function () {
        var target = card.getAttribute('data-nav');
        if (target) switchView(target);
      });
    });

    // Sidebar toggle (mobile)
    var sidebarToggle = AC._root.getElementById('sidebar-toggle');
    var sidebar = AC._root.getElementById('sidebar');
    var sidebarOverlay = AC._root.getElementById('sidebar-overlay');

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

    AC._root.querySelectorAll('.nav-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var view = this.getAttribute('data-view');
        if (AC._root === document) location.hash = view;
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
        var links = Array.from(AC._root.querySelectorAll('.nav-link'));
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

    AC._root.getElementById('msg-search').addEventListener('input', AC.triggerSearch);
    AC._root.getElementById('state-filter').addEventListener('input', AC.renderState);

    var feedTypeFilter = AC._root.getElementById('feed-type-filter');
    if (feedTypeFilter) {
      feedTypeFilter.addEventListener('change', AC.renderFeed);
    }

    var clearMsgsBtn = AC._root.getElementById('msg-clear');
    if (clearMsgsBtn) {
      clearMsgsBtn.addEventListener('click', function () {
        if (!confirm('Clear all messages? This cannot be undone.')) return;
        AC._fetch('/api/messages', { method: 'DELETE' })
          .then(function () {
            AC.state.messages = [];
            AC.state.messageCount = 0;
            render();
            showToast('Cleared', 'All messages purged');
          })
          .catch(function () {
            showToast('Error', 'Failed to clear messages');
          });
      });
    }

    AC._root.getElementById('messages-list').addEventListener('click', function (e) {
      var item = e.target.closest('.msg-compact[data-msg-id]');
      if (!item) return;
      var msgId = parseInt(item.getAttribute('data-msg-id'), 10);
      AC.selectedMessageId = msgId;

      var container = AC._root.getElementById('messages-list');
      container.querySelectorAll('.msg-compact.selected').forEach(function (el) {
        el.classList.remove('selected');
      });
      item.classList.add('selected');

      var messages = AC.state.messages || [];
      var threadRoots = {};
      messages.forEach(function (m) {
        if (m.thread_id) {
          if (!threadRoots[m.thread_id]) threadRoots[m.thread_id] = [];
          threadRoots[m.thread_id].push(m);
        }
      });
      AC.renderMessageDetail(msgId, threadRoots);
    });

    // Event delegation for morphdom-managed containers
    AC._root.getElementById('agents-list').addEventListener('click', function (e) {
      var card = e.target.closest('.agent-card[data-agent-id]');
      if (card) AC.setMessageFilter('agent', card.getAttribute('data-agent-id'));
    });
    AC._root.getElementById('channels-list').addEventListener('click', function (e) {
      var card = e.target.closest('[data-channel-id]');
      if (card) AC.setMessageFilter('channel', card.getAttribute('data-channel-id'));
    });
    AC._root.getElementById('overview-agents').addEventListener('click', function (e) {
      var el = e.target.closest('[data-agent-id]');
      if (el) AC.setMessageFilter('agent', el.getAttribute('data-agent-id'));
    });
    AC._root.getElementById('overview-activity').addEventListener('click', function (e) {
      var el = e.target.closest('[data-msg-id]');
      if (!el) return;
      var msgId = parseInt(el.getAttribute('data-msg-id'), 10);
      AC.selectedMessageId = msgId;
      AC.messageFilters.agent = null;
      AC.messageFilters.channel = null;
      if (AC._root === document) location.hash = 'messages';
      switchView('messages');
      AC.renderMessages();
      setTimeout(function () {
        var target = AC._root.querySelector('.msg-compact[data-msg-id="' + msgId + '"]');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    });

    // In plugin mode (shadow DOM), don't use location.hash — default to overview
    if (AC._root !== document) {
      switchView('overview');
    } else {
      window.addEventListener('hashchange', handleHash);
      handleHash();
    }
    connect();

    // ---------------------------------------------------------------------------
    // Theme sync from parent (agent-desk) via executeJavaScript
    // ---------------------------------------------------------------------------

    window.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'theme-sync') return;
      var colors = event.data.colors;
      if (!colors) return;

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

      if (colors.bg) root.style.setProperty('--bg', colors.bg);
      if (colors.bgSurface) root.style.setProperty('--bg-surface', colors.bgSurface);
      if (colors.bgElevated) root.style.setProperty('--bg-elevated', colors.bgElevated);
      if (colors.bgHover) root.style.setProperty('--bg-hover', colors.bgHover);

      if (colors.border) root.style.setProperty('--border', colors.border);
      if (colors.borderLight) root.style.setProperty('--border-light', colors.borderLight);

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

      if (colors.accent) root.style.setProperty('--accent', colors.accent);
      if (colors.accentDim) root.style.setProperty('--accent-dim', colors.accentDim);

      if (colors.green) root.style.setProperty('--green', colors.green);
      if (colors.yellow) root.style.setProperty('--yellow', colors.yellow);
      if (colors.orange) root.style.setProperty('--orange', colors.orange);
      if (colors.red) root.style.setProperty('--red', colors.red);
      if (colors.purple) root.style.setProperty('--purple', colors.purple);

      if (colors.focusRing) root.style.setProperty('--focus-ring', colors.focusRing);

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

      if (colors.isDark !== undefined) {
        if (colors.isDark) {
          document.documentElement.setAttribute('data-theme', 'dark');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
        localStorage.setItem('agent-comm-theme', colors.isDark ? 'dark' : 'light');
        updateThemeIcon(colors.isDark ? 'dark' : 'light');
      }

      var themeToggle = AC._root.getElementById('theme-toggle');
      if (themeToggle) themeToggle.style.display = 'none';
    });
  } // end _init

  // -----------------------------------------------------------------------
  // Plugin API — mount / unmount
  // -----------------------------------------------------------------------

  /**
   * Mount the agent-comm UI into a container element.
   * @param {HTMLElement} container - DOM element to mount into
   * @param {Object} [options]
   * @param {string} [options.baseUrl] - HTTP base URL (e.g. 'http://localhost:3421')
   * @param {string} [options.wsUrl]   - WebSocket host (e.g. 'localhost:3421')
   * @param {string} [options.cssUrl]  - URL of styles.css to inject
   */
  AC.mount = function (container, options) {
    options = options || {};
    AC._baseUrl = options.baseUrl || '';
    AC._wsUrl = options.wsUrl || null;

    var shadow = container.attachShadow({ mode: 'open' });

    if (options.cssUrl) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = options.cssUrl;
      shadow.appendChild(link);
    }

    var fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href =
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';
    shadow.appendChild(fonts);
    var icons = document.createElement('link');
    icons.rel = 'stylesheet';
    icons.href =
      'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap';
    shadow.appendChild(icons);

    var pluginStyle = document.createElement('style');
    pluginStyle.textContent =
      ':host { display:block; width:100%; height:100%; overflow:hidden; }' +
      '.ac-wrapper { font-family:var(--font-sans); font-size:14px; color:var(--text); background:var(--bg); line-height:1.5; width:100%; height:100%; overflow:hidden; }' +
      '.ac-wrapper #app { height:100%; }';
    shadow.appendChild(pluginStyle);

    if (typeof AC._template === 'function') {
      var wrapper = document.createElement('div');
      wrapper.setAttribute('data-theme', 'dark');
      wrapper.className = 'ac-wrapper';
      wrapper.innerHTML = AC._template();
      shadow.appendChild(wrapper);
    }

    AC._root = shadow;
    _init();
    var themeBtn = shadow.getElementById('theme-toggle');
    if (themeBtn) themeBtn.style.display = 'none';
  };

  AC.unmount = function () {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    clearTimeout(reconnectTimer);
    loaded = false;
    lastStateFingerprint = '';
    AC.state = {
      agents: [],
      channels: [],
      messages: [],
      state: [],
      messageCount: 0,
      feed: [],
      branches: [],
    };
    AC._root = document;
  };

  // Auto-init — check URL params for embedded mode (iframe in agent-desk)
  var params = new URLSearchParams(location.search);
  if (params.get('baseUrl')) AC._baseUrl = params.get('baseUrl');
  if (params.get('wsUrl')) AC._wsUrl = params.get('wsUrl');
  try {
    _init();
  } catch (e) {
    /* standalone init may fail in file:// context — plugin mode uses mount() */
  }
})();
