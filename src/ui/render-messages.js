// =============================================================================
// agent-comm — Message list and detail rendering
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  AC.selectedMessageId = null;
  AC.messageFilters = { agent: null, channel: null };
  var searchDebounce = null;
  AC.searchResults = null;

  // Lazy loading state
  var MSG_PAGE_SIZE = 50;
  AC.msgDisplayCount = MSG_PAGE_SIZE;
  AC.msgLoadingOlder = false;
  var scrollListenerAttached = false;

  /** Return the currently filtered message list (without slicing for display). */
  function getFilteredMessages() {
    var messages = AC.state.messages || [];
    var searchInput = document.getElementById('msg-search');
    var query = (searchInput ? searchInput.value : '').trim();

    var result = AC.searchResults !== null ? AC.searchResults : messages;
    if (AC.searchResults === null) {
      if (AC.messageFilters.agent) {
        var agentId = AC.messageFilters.agent;
        result = result.filter(function (m) {
          return m.from_agent === agentId || m.to_agent === agentId;
        });
      }
      if (AC.messageFilters.channel) {
        var chId = AC.messageFilters.channel;
        result = result.filter(function (m) {
          return m.channel_id === chId;
        });
      }
      if (query && query.length === 1) {
        var filter = query.toLowerCase();
        result = result.filter(function (m) {
          return (
            (m.content || '').toLowerCase().indexOf(filter) !== -1 ||
            AC.resolveAgentName(m.from_agent).toLowerCase().indexOf(filter) !== -1
          );
        });
      }
    }
    return result;
  }

  function setMessageFilter(type, value) {
    AC.messageFilters[type] = AC.messageFilters[type] === value ? null : value;
    AC.searchResults = null;
    AC.msgDisplayCount = MSG_PAGE_SIZE;
    var searchInput = document.getElementById('msg-search');
    if (searchInput) searchInput.value = '';
    location.hash = 'messages';
    AC.switchView('messages');
    renderMessages();
  }

  function triggerSearch() {
    var searchInput = document.getElementById('msg-search');
    var query = (searchInput.value || '').trim();
    if (query.length < 2) {
      AC.searchResults = null;
      AC.msgDisplayCount = MSG_PAGE_SIZE;
      renderMessages();
      return;
    }
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () {
      AC._fetch('/api/search?q=' + encodeURIComponent(query) + '&limit=50')
        .then(function (r) {
          return r.json();
        })
        .then(function (results) {
          AC.searchResults = results.map(function (r) {
            return r.message;
          });
          AC.msgDisplayCount = MSG_PAGE_SIZE;
          renderMessages();
        })
        .catch(function () {
          AC.searchResults = null;
          renderMessages();
        });
    }, 300);
  }

  function renderMessages() {
    var messages = AC.state.messages || [];
    var container = document.getElementById('messages-list');
    var detailPane = document.getElementById('message-detail');
    var searchInput = document.getElementById('msg-search');
    var query = (searchInput.value || '').trim();

    var filtered = AC.searchResults !== null ? AC.searchResults : messages;
    if (AC.searchResults === null) {
      if (AC.messageFilters.agent) {
        var agentId = AC.messageFilters.agent;
        filtered = filtered.filter(function (m) {
          return m.from_agent === agentId || m.to_agent === agentId;
        });
      }
      if (AC.messageFilters.channel) {
        var chId = AC.messageFilters.channel;
        filtered = filtered.filter(function (m) {
          return m.channel_id === chId;
        });
      }
      if (query && query.length === 1) {
        var filter = query.toLowerCase();
        filtered = filtered.filter(function (m) {
          return (
            (m.content || '').toLowerCase().indexOf(filter) !== -1 ||
            AC.resolveAgentName(m.from_agent).toLowerCase().indexOf(filter) !== -1
          );
        });
      }
    }

    var filtersEl = document.getElementById('msg-filters');
    if (filtersEl) {
      var chips = [];
      if (AC.searchResults !== null) {
        chips.push(
          '<span class="filter-chip">FTS: ' +
            filtered.length +
            ' results <button class="chip-remove" data-clear="search">&times;</button></span>',
        );
      }
      if (AC.messageFilters.agent) {
        chips.push(
          '<span class="filter-chip">Agent: ' +
            AC.esc(AC.resolveAgentName(AC.messageFilters.agent)) +
            ' <button class="chip-remove" data-clear="agent">&times;</button></span>',
        );
      }
      if (AC.messageFilters.channel) {
        chips.push(
          '<span class="filter-chip">Channel: ' +
            AC.esc(AC.resolveChannelName(AC.messageFilters.channel)) +
            ' <button class="chip-remove" data-clear="channel">&times;</button></span>',
        );
      }
      filtersEl.innerHTML = chips.join('');
      filtersEl.querySelectorAll('.chip-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var key = this.getAttribute('data-clear');
          if (key === 'search') {
            AC.searchResults = null;
            document.getElementById('msg-search').value = '';
          } else {
            AC.messageFilters[key] = null;
          }
          AC.msgDisplayCount = MSG_PAGE_SIZE;
          renderMessages();
        });
      });
    }

    if (filtered.length === 0) {
      AC.morph(
        container,
        '<div class="empty-state">' +
          (query ||
          AC.messageFilters.agent ||
          AC.messageFilters.channel ||
          AC.searchResults !== null
            ? 'No matching messages'
            : '<span class="material-symbols-outlined empty-state-icon">inbox</span>No messages yet') +
          '</div>',
      );
      if (detailPane)
        AC.morph(
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

    // Lazy loading: only render up to msgDisplayCount messages
    var totalFiltered = filtered.length;
    var totalOnServer = AC.state.messageCount || totalFiltered;
    var visible = filtered;
    var hasMore = totalOnServer > totalFiltered;

    // Build loading indicator + visible messages
    var loadingIndicator = hasMore
      ? '<div class="msg-load-older" id="msg-load-older">' +
        '<span class="material-symbols-outlined msg-load-older-icon">hourglass_top</span>' +
        'Loading older messages...</div>'
      : '';

    AC.morph(
      container,
      loadingIndicator +
        visible
          .map(function (m) {
            var fromName = AC.resolveAgentName(m.from_agent);
            var toLabel = m.to_agent
              ? '&rarr; ' + AC.esc(AC.resolveAgentName(m.to_agent))
              : m.channel_id
                ? '&rarr; ' + AC.esc(AC.resolveChannelName(m.channel_id))
                : '';
            var isFwd = /--- Forwarded from .+ ---/.test(m.content || '');
            var isHandoff = /--- HANDOFF from .+ to .+ ---/.test(m.content || '');
            var rawPreview = AC.stripMd(m.content || '');
            if (isFwd) {
              var fwdParts = (m.content || '').match(/--- Forwarded from .+ ---\n([\s\S]*)/);
              rawPreview = fwdParts ? AC.stripMd(fwdParts[1]) : rawPreview;
            }
            var preview = rawPreview.substring(0, 80);
            if (rawPreview.length > 80) preview += '...';
            var replies = threadRoots[m.id] || [];
            var isSelected = AC.selectedMessageId === m.id;

            return (
              '<div class="msg-compact no-anim' +
              (isSelected ? ' selected' : '') +
              '" data-msg-id="' +
              m.id +
              '">' +
              '<div class="msg-compact-header">' +
              '<span class="message-avatar">' +
              AC.esc(fromName.substring(0, 2).toUpperCase()) +
              '</span>' +
              '<span class="msg-compact-from">' +
              AC.esc(fromName) +
              '</span>' +
              '<span class="msg-compact-to">' +
              toLabel +
              '</span>' +
              '<span class="msg-compact-time">' +
              AC.timeAgo(m.created_at) +
              '</span>' +
              '</div>' +
              '<div class="msg-compact-preview">' +
              AC.esc(preview) +
              '</div>' +
              '<div class="msg-compact-badges">' +
              (m.importance && m.importance !== 'normal'
                ? '<span class="importance-badge importance-' +
                  AC.esc(m.importance) +
                  '">' +
                  AC.esc(m.importance) +
                  '</span>'
                : '') +
              (isHandoff
                ? '<span class="message-tag handoff-tag"><span class="material-symbols-outlined" style="font-size:11px;vertical-align:-1px">swap_horiz</span> handoff</span>'
                : '') +
              (isFwd && !isHandoff ? '<span class="message-tag fwd-tag">fwd</span>' : '') +
              (m.branch_id
                ? '<span class="message-tag branch-tag"><span class="material-symbols-outlined" style="font-size:11px;vertical-align:-1px">call_split</span> branch</span>'
                : '') +
              (replies.length > 0
                ? '<span class="message-tag thread-count">' + replies.length + ' replies</span>'
                : '') +
              (m.thread_id ? '<span class="message-tag">reply</span>' : '') +
              (m.ack_required ? '<span class="message-tag ack-tag">ack</span>' : '') +
              (function () {
                var branchesFromMsg = (AC.state.branches || []).filter(function (b) {
                  return b.parent_message_id === m.id;
                });
                if (branchesFromMsg.length === 0) return '';
                return (
                  '<span class="message-tag branch-indicator-tag"><span class="material-symbols-outlined" style="font-size:11px;vertical-align:-1px">account_tree</span> ' +
                  branchesFromMsg.length +
                  ' branch' +
                  (branchesFromMsg.length > 1 ? 'es' : '') +
                  '</span>'
                );
              })() +
              '</div>' +
              '</div>'
            );
          })
          .join(''),
    );

    // Hide loading indicator when not actively loading
    var loadEl = document.getElementById('msg-load-older');
    if (loadEl) {
      loadEl.style.display = AC.msgLoadingOlder ? '' : 'none';
    }

    // Scroll to bottom on initial render so user sees newest messages first
    if (!scrollListenerAttached) {
      requestAnimationFrame(function () {
        container.scrollTop = container.scrollHeight;
      });
    }

    // Attach scroll listener for lazy loading (once)
    if (!scrollListenerAttached) {
      scrollListenerAttached = true;
      container.addEventListener('scroll', function () {
        if (AC.msgLoadingOlder) return;
        // Trigger when scrolled near the top (within 80px) to load older messages
        if (container.scrollTop < 80 && container.scrollHeight > container.clientHeight) {
          var totalOnServer = AC.state.messageCount || AC.state.messages.length;
          var loadedCount = (AC.state.messages || []).length;
          if (loadedCount < totalOnServer) {
            AC.msgLoadingOlder = true;
            var indicator = document.getElementById('msg-load-older');
            if (indicator) indicator.style.display = '';
            var prevScrollHeight = container.scrollHeight;

            // Fetch older messages via REST
            AC._fetch('/api/messages?limit=' + MSG_PAGE_SIZE + '&offset=' + loadedCount)
              .then(function (r) {
                return r.json();
              })
              .then(function (older) {
                if (older && older.length > 0) {
                  AC.state.messages = AC.state.messages.concat(older);
                }
                AC.msgDisplayCount = AC.state.messages.length;
                renderMessages();
                var newScrollHeight = container.scrollHeight;
                container.scrollTop += newScrollHeight - prevScrollHeight;
                AC.msgLoadingOlder = false;
              })
              .catch(function () {
                AC.msgLoadingOlder = false;
              });
          }
        }
      });
    }

    if (AC.selectedMessageId) {
      renderMessageDetail(AC.selectedMessageId, threadRoots);
    } else if (detailPane) {
      detailPane.innerHTML =
        '<div class="detail-empty"><span class="material-symbols-outlined detail-empty-icon">mail</span><div>Select a message to view details</div></div>';
    }
  }

  function renderMessageDetail(msgId, threadRoots) {
    var detailPane = document.getElementById('message-detail');
    if (!detailPane) return;

    var messages = AC.state.messages || [];
    var msg = AC.findById(messages, msgId);
    if (!msg) {
      detailPane.innerHTML =
        '<div class="detail-empty"><span class="material-symbols-outlined detail-empty-icon">mail</span><div>Message not found</div></div>';
      return;
    }

    var fromName = AC.resolveAgentName(msg.from_agent);
    var toLabel = msg.to_agent
      ? 'To: ' + AC.esc(AC.resolveAgentName(msg.to_agent))
      : msg.channel_id
        ? 'In: ' + AC.esc(AC.resolveChannelName(msg.channel_id))
        : '';
    var replies = (threadRoots && threadRoots[msg.id]) || [];

    var handoffMatch = (msg.content || '').match(
      /^--- HANDOFF from (.+?) to (.+?) ---\n\n([\s\S]*?)\n--- End of handoff ---$/,
    );
    var isHandoff = !!handoffMatch;

    var fwdMatch = !isHandoff
      ? (msg.content || '').match(/^([\s\S]*?)--- Forwarded from (.+?) ---\n([\s\S]*)$/)
      : null;
    var fwdComment = fwdMatch ? fwdMatch[1].trim() : '';
    var fwdFrom = fwdMatch ? fwdMatch[2] : '';
    var fwdBody = fwdMatch ? fwdMatch[3] : '';
    var isForwarded = !!fwdMatch;

    var html =
      '<div class="detail-card">' +
      '<div class="detail-header">' +
      '<div class="detail-avatar">' +
      AC.esc(fromName.substring(0, 2).toUpperCase()) +
      '</div>' +
      '<div class="detail-sender">' +
      '<div class="detail-sender-name">' +
      AC.esc(fromName) +
      '</div>' +
      '<div class="detail-sender-meta">' +
      toLabel +
      ' &middot; ' +
      AC.timeAgo(msg.created_at) +
      (msg.edited_at ? ' &middot; edited' : '') +
      '</div>' +
      '</div>' +
      '<div class="detail-badges">' +
      (isHandoff
        ? '<span class="message-tag handoff-tag"><span class="material-symbols-outlined" style="font-size:12px;vertical-align:-2px">swap_horiz</span> handoff</span>'
        : '') +
      (isForwarded
        ? '<span class="message-tag fwd-tag"><span class="material-symbols-outlined" style="font-size:12px;vertical-align:-2px">forward_to_inbox</span> forwarded</span>'
        : '') +
      (msg.branch_id
        ? '<span class="message-tag branch-tag"><span class="material-symbols-outlined" style="font-size:12px;vertical-align:-2px">call_split</span> branch</span>'
        : '') +
      (msg.importance && msg.importance !== 'normal'
        ? '<span class="importance-badge importance-' +
          AC.esc(msg.importance) +
          '">' +
          AC.esc(msg.importance) +
          '</span>'
        : '') +
      (msg.ack_required ? '<span class="message-tag ack-tag">ack</span>' : '') +
      '</div>' +
      '</div>';

    if (msg.thread_id) {
      var parent = AC.findById(messages, msg.thread_id);
      if (parent) {
        var parentPreview = AC.stripMd(parent.content || '').substring(0, 120);
        if ((parent.content || '').length > 120) parentPreview += '...';
        html +=
          '<div class="detail-reply-context" data-goto-msg="' +
          parent.id +
          '">' +
          '<span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px;margin-right:4px;color:var(--text-dim)">reply</span>' +
          '<span class="reply-context-name">' +
          AC.esc(AC.resolveAgentName(parent.from_agent)) +
          '</span> ' +
          '<span class="reply-context-preview">' +
          AC.esc(parentPreview) +
          '</span>' +
          '</div>';
      }
    }

    if (isHandoff) {
      var handoffFrom = handoffMatch[1];
      var handoffTo = handoffMatch[2];
      var handoffBody = handoffMatch[3];
      html +=
        '<div class="handoff-block">' +
        '<div class="handoff-header"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;margin-right:6px">swap_horiz</span>Handoff from <strong>' +
        AC.esc(handoffFrom) +
        '</strong> to <strong>' +
        AC.esc(handoffTo) +
        '</strong></div>' +
        '<div class="handoff-body prose">' +
        AC.renderMd(handoffBody) +
        '</div>' +
        '</div>';
    } else if (isForwarded) {
      if (fwdComment) {
        html += '<div class="detail-body prose">' + AC.renderMd(fwdComment) + '</div>';
      }
      html +=
        '<div class="forwarded-block">' +
        '<div class="forwarded-header"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px;margin-right:4px">forward_to_inbox</span>Forwarded from <strong>' +
        AC.esc(fwdFrom) +
        '</strong></div>' +
        '<div class="forwarded-body prose">' +
        AC.renderMd(fwdBody) +
        '</div>' +
        '</div>';
    } else {
      html += '<div class="detail-body prose">' + AC.renderMd(msg.content) + '</div>';
    }

    var msgBranches = (AC.state.branches || []).filter(function (b) {
      return b.parent_message_id === msg.id;
    });
    if (msgBranches.length > 0) {
      html +=
        '<div class="detail-branches">' +
        '<div class="detail-branches-title"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px;margin-right:4px">account_tree</span>Branches (' +
        msgBranches.length +
        ')</div>';
      msgBranches.forEach(function (b) {
        var creatorName = b.created_by ? AC.resolveAgentName(b.created_by) : 'unknown';
        html +=
          '<div class="branch-item">' +
          '<span class="material-symbols-outlined" style="font-size:14px;color:var(--purple);margin-right:6px">call_split</span>' +
          '<span class="branch-name">' +
          AC.esc(b.name || 'branch-' + b.id) +
          '</span>' +
          '<span class="branch-meta"> by ' +
          AC.esc(creatorName) +
          ' &middot; ' +
          AC.timeAgo(b.created_at) +
          '</span>' +
          '</div>';
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
        var rName = AC.resolveAgentName(r.from_agent);
        html +=
          '<div class="thread-msg" data-goto-msg="' +
          r.id +
          '">' +
          '<div class="thread-msg-avatar">' +
          AC.esc(rName.substring(0, 2).toUpperCase()) +
          '</div>' +
          '<div class="thread-msg-content">' +
          '<div class="thread-msg-header">' +
          '<span class="thread-msg-name">' +
          AC.esc(rName) +
          '</span>' +
          '<span class="thread-msg-time">' +
          AC.timeAgo(r.created_at) +
          '</span>' +
          '</div>' +
          '<div class="thread-msg-body prose">' +
          AC.renderMd(r.content) +
          '</div>' +
          '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    html += '</div>';

    detailPane.innerHTML = html;
    detailPane.querySelectorAll('[data-goto-msg]').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        var targetId = parseInt(this.getAttribute('data-goto-msg'), 10);
        AC.selectedMessageId = targetId;
        renderMessages();
        var targetEl = document.querySelector('.msg-compact[data-msg-id="' + targetId + '"]');
        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  AC.setMessageFilter = setMessageFilter;
  AC.triggerSearch = triggerSearch;
  AC.renderMessages = renderMessages;
  AC.renderMessageDetail = renderMessageDetail;
})();
