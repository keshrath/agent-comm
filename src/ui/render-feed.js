// =============================================================================
// agent-comm — Activity feed timeline rendering
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  var FEED_PAGE_SIZE = 30;
  AC._feedDisplayCount = FEED_PAGE_SIZE;
  AC._feedScrollBound = false;

  var FEED_TYPE_ICONS = {
    commit: 'commit',
    test_pass: 'check_circle',
    test_fail: 'cancel',
    file_edit: 'edit_document',
    task_complete: 'task_alt',
    error: 'error',
    custom: 'extension',
    register: 'person_add',
    message: 'chat_bubble',
    state_change: 'sync_alt',
    handoff: 'swap_horiz',
    branch: 'call_split',
    'hook-block': 'block',
  };

  var FEED_TYPE_COLORS = {
    commit: 'var(--purple, #7c3aed)',
    test_pass: 'var(--green, #22c55e)',
    test_fail: 'var(--red, #ef4444)',
    file_edit: 'var(--accent, #5d8da8)',
    task_complete: 'var(--green, #22c55e)',
    error: 'var(--red, #ef4444)',
    custom: 'var(--text-muted, #888)',
    register: 'var(--accent, #5d8da8)',
    message: 'var(--accent, #5d8da8)',
    state_change: 'var(--yellow, #eab308)',
    handoff: 'var(--orange, #db6d28)',
    branch: 'var(--purple, #7c3aed)',
    // hook-block = rare-but-real "prevented conflict" moment. Warning-orange
    // with a block icon so it visually stands apart from routine activity.
    'hook-block': 'var(--orange, #db6d28)',
  };

  // Derive a human-readable phrase for a hook-block event. The preview is a
  // JSON payload emitted by scripts/hooks/_fail-open.mjs signalBlock(); we
  // parse it best-effort and build something like:
  //   "prevented Edit conflict on src/foo.ts (held by agent-bar)"
  //   "prevented Bash conflict: git commit -am ... (rule: git-commit)"
  // Falls back to the raw preview if parsing fails.
  function hookBlockPhrase(e) {
    if (!e || typeof e.preview !== 'string') return null;
    try {
      var p = JSON.parse(e.preview);
      if (!p || typeof p !== 'object') return null;
      var tool = p.tool || 'tool';
      var parts = ['prevented ' + tool + ' conflict'];
      if (p.target) parts.push('on ' + p.target);
      if (p.holder_agent && p.holder_agent !== p.blocked_agent) {
        parts.push('(held by ' + p.holder_agent + ')');
      } else if (p.rule) {
        parts.push('(rule: ' + p.rule + ')');
      }
      return parts.join(' ');
    } catch (_) {
      return null;
    }
  }

  function renderFeedItem(e) {
    var icon = FEED_TYPE_ICONS[e.type] || 'circle';
    var color = FEED_TYPE_COLORS[e.type] || 'var(--text-muted)';
    var agentName = e.agent_id ? AC.resolveAgentName(e.agent_id) : 'system';
    var isBlock = e.type === 'hook-block';
    var typeClass = isBlock ? 'feed-item feed-item-block' : 'feed-item';
    var typeLabel = isBlock ? 'hook block' : e.type;
    var phrase = isBlock ? hookBlockPhrase(e) : null;
    var showTarget = e.target && !phrase; // phrase already mentions target
    var showPreview = e.preview && !isBlock; // preview is raw JSON for hook-block; prefer phrase
    return (
      '<div class="' +
      typeClass +
      '">' +
      '<div class="feed-icon" style="color:' +
      color +
      '"><span class="material-symbols-outlined">' +
      icon +
      '</span></div>' +
      '<div class="feed-content">' +
      '<div class="feed-header">' +
      '<span class="feed-type" style="color:' +
      color +
      '">' +
      AC.esc(typeLabel) +
      '</span>' +
      '<span class="feed-agent">' +
      AC.esc(agentName) +
      '</span>' +
      '<span class="feed-time">' +
      AC.timeAgo(e.created_at) +
      '</span>' +
      '</div>' +
      (phrase
        ? '<div class="feed-block-phrase" style="color:' +
          color +
          ';font-weight:600">' +
          AC.esc(phrase) +
          '</div>'
        : '') +
      (showTarget ? '<div class="feed-target">' + AC.esc(e.target) + '</div>' : '') +
      (showPreview ? '<div class="feed-preview">' + AC.esc(e.preview) + '</div>' : '') +
      '</div>' +
      '</div>'
    );
  }

  function onFeedScroll() {
    // Feed view must be active for scroll to matter
    var feedView = AC._root.getElementById('view-feed');
    if (!feedView || !feedView.classList.contains('active')) return;

    var scrollParent = AC._root.getElementById('content');
    if (!scrollParent) return;
    var threshold = 100;
    var nearBottom =
      scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight < threshold;
    if (nearBottom && !AC._feedLoading) {
      var feed = AC.state.feed || [];
      var filterEl = AC._root.getElementById('feed-type-filter');
      var typeFilter = filterEl ? filterEl.value : '';
      var loadedCount = feed.length;

      AC._feedLoading = true;
      var url = '/api/feed?limit=' + FEED_PAGE_SIZE + '&offset=' + loadedCount;
      if (typeFilter) url += '&type=' + encodeURIComponent(typeFilter);

      AC._fetch(url)
        .then(function (r) {
          return r.json();
        })
        .then(function (older) {
          if (older && older.length > 0) {
            AC.state.feed = feed.concat(older);
            AC._feedDisplayCount = AC.state.feed.length;
            renderFeed(false);
          }
          AC._feedLoading = false;
        })
        .catch(function () {
          AC._feedLoading = false;
        });
    }
  }

  function bindFeedScroll() {
    if (AC._feedScrollBound) return;
    var scrollParent = AC._root.getElementById('content');
    if (!scrollParent) return;
    scrollParent.addEventListener('scroll', onFeedScroll);
    AC._feedScrollBound = true;
  }

  function renderFeed(resetPage) {
    var feed = AC.state.feed || [];
    var container = AC._root.getElementById('feed-list');
    if (!container) return;

    bindFeedScroll();

    var filterEl = AC._root.getElementById('feed-type-filter');
    var typeFilter = filterEl ? filterEl.value : '';

    // Reset page count on new data or filter change
    if (resetPage !== false) {
      AC._feedDisplayCount = FEED_PAGE_SIZE;
    }

    var filtered = feed;
    if (typeFilter) {
      filtered = feed.filter(function (e) {
        return e.type === typeFilter;
      });
    }

    if (filtered.length === 0) {
      AC.morph(
        container,
        '<div class="empty-state">' +
          '<span class="material-symbols-outlined empty-state-icon">rss_feed</span>' +
          (typeFilter
            ? 'No events of type "' + AC.esc(typeFilter) + '"'
            : 'No activity events yet') +
          '<div class="empty-state-hint">Events appear when agents log activities</div>' +
          '</div>',
      );
      return;
    }

    var visible = filtered.slice(0, AC._feedDisplayCount);
    var hasMore = AC._feedDisplayCount < filtered.length;

    var html = visible.map(renderFeedItem).join('');

    if (hasMore) {
      html +=
        '<div class="feed-load-more">' +
        '<span class="material-symbols-outlined feed-load-more-icon">pending</span>' +
        'Loading more\u2026' +
        '</div>';
    }

    AC.morph(container, html);
  }

  AC.renderFeed = function () {
    renderFeed(true);
  };
})();
