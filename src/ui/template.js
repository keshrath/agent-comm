// =============================================================================
// agent-comm — HTML template for plugin mount
// =============================================================================
// Extracted from index.html body. Used by AC.mount() to inject into container.
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  AC._template = function () {
    return (
      '<div id="app">' +
      '<button id="sidebar-toggle" class="sidebar-toggle" aria-label="Toggle navigation" aria-expanded="false">' +
      '<span class="material-symbols-outlined">menu</span></button>' +
      '<div id="sidebar-overlay" class="sidebar-overlay"></div>' +
      '<nav id="sidebar" role="navigation" aria-label="Main navigation">' +
      '<div class="sidebar-header">' +
      '<div class="brand"><span class="brand-icon material-symbols-outlined">hub</span><h1>agent-comm</h1></div>' +
      '<div class="sidebar-header-row"><span class="version" id="version"></span>' +
      '<button id="theme-toggle" class="icon-btn" title="Toggle theme" aria-label="Toggle theme">' +
      '<span class="theme-icon material-symbols-outlined">dark_mode</span></button></div></div>' +
      '<ul class="nav-items" role="tablist">' +
      '<li role="presentation"><a href="#overview" id="tab-overview" class="nav-link active" data-view="overview" role="tab" tabindex="0" aria-selected="true"><span class="material-symbols-outlined nav-icon">dashboard</span>Overview</a></li>' +
      '<li role="presentation"><a href="#agents" id="tab-agents" class="nav-link" data-view="agents" role="tab" tabindex="-1"><span class="material-symbols-outlined nav-icon">smart_toy</span>Agents</a></li>' +
      '<li role="presentation"><a href="#messages" id="tab-messages" class="nav-link" data-view="messages" role="tab" tabindex="-1"><span class="material-symbols-outlined nav-icon">chat</span>Messages</a></li>' +
      '<li role="presentation"><a href="#channels" id="tab-channels" class="nav-link" data-view="channels" role="tab" tabindex="-1"><span class="material-symbols-outlined nav-icon">forum</span>Channels</a></li>' +
      '<li role="presentation"><a href="#state" id="tab-state" class="nav-link" data-view="state" role="tab" tabindex="-1"><span class="material-symbols-outlined nav-icon">database</span>State</a></li>' +
      '<li role="presentation"><a href="#feed" id="tab-feed" class="nav-link" data-view="feed" role="tab" tabindex="-1"><span class="material-symbols-outlined nav-icon">rss_feed</span>Activity</a></li>' +
      '</ul>' +
      '<div class="sidebar-footer"><span class="connection-status" id="conn-status" role="status" aria-live="polite"><span class="conn-dot"></span>Connecting...</span></div>' +
      '</nav>' +
      '<main id="content">' +
      '<div id="loading-overlay" class="loading-overlay"><div class="loading-spinner"></div><div class="loading-text">Connecting to agent-comm...</div></div>' +
      '<section id="view-overview" class="view active" role="tabpanel" aria-labelledby="tab-overview">' +
      '<div class="overview-header"><h2>Overview</h2><div class="overview-actions">' +
      '<button id="overview-cleanup" class="icon-btn" title="Clean up offline agents &amp; stale data" aria-label="Clean up"><span class="material-symbols-outlined">mop</span></button>' +
      '<button id="overview-refresh" class="icon-btn" title="Refresh dashboard" aria-label="Refresh"><span class="material-symbols-outlined">refresh</span></button>' +
      '</div></div>' +
      '<div class="stats-grid">' +
      '<div class="stat-card stat-card-link" data-nav="agents"><span class="material-symbols-outlined stat-icon">smart_toy</span><div class="stat-value" id="stat-agents">0</div><div class="stat-label">Agents Online</div></div>' +
      '<div class="stat-card stat-card-link" data-nav="channels"><span class="material-symbols-outlined stat-icon">forum</span><div class="stat-value" id="stat-channels">0</div><div class="stat-label">Channels</div></div>' +
      '<div class="stat-card stat-card-link" data-nav="messages"><span class="material-symbols-outlined stat-icon">chat</span><div class="stat-value" id="stat-messages">0</div><div class="stat-label">Messages</div></div>' +
      '<div class="stat-card stat-card-link" data-nav="state"><span class="material-symbols-outlined stat-icon">database</span><div class="stat-value" id="stat-state">0</div><div class="stat-label">State Entries</div></div>' +
      '</div>' +
      '<div class="panel"><h3><span class="material-symbols-outlined panel-icon">group</span>Active Agents</h3><div id="overview-agents" class="panel-body"></div></div>' +
      '<div class="panel" style="margin-top:16px"><h3><span class="material-symbols-outlined panel-icon">history</span>Recent Activity</h3><div id="overview-activity" class="panel-body"></div></div>' +
      '</section>' +
      '<section id="view-agents" class="view" role="tabpanel" aria-labelledby="tab-agents"><h2><span class="material-symbols-outlined view-icon">smart_toy</span>Agents</h2><div id="agents-list" class="card-grid"></div></section>' +
      '<section id="view-messages" class="view" role="tabpanel" aria-labelledby="tab-messages">' +
      '<div class="split-pane"><div class="split-left"><div class="split-left-header">' +
      '<h2><span class="material-symbols-outlined view-icon">chat</span>Messages</h2>' +
      '<div class="search-wrapper"><span class="material-symbols-outlined search-icon">search</span><input type="search" id="msg-search" placeholder="Full-text search all messages..." class="search-input search-sm" aria-label="Search messages" /></div>' +
      '<button id="msg-clear" class="icon-btn" title="Clear all messages" aria-label="Clear all messages"><span class="material-symbols-outlined">delete_sweep</span></button>' +
      '</div><div id="msg-filters" class="filter-chips"></div><div id="messages-list" class="message-list-compact"></div></div>' +
      '<div class="split-right" id="message-detail"><div class="detail-empty"><span class="material-symbols-outlined detail-empty-icon">mail</span><div>Select a message to view details</div></div></div></div>' +
      '</section>' +
      '<section id="view-channels" class="view" role="tabpanel" aria-labelledby="tab-channels"><h2><span class="material-symbols-outlined view-icon">forum</span>Channels</h2><div id="channels-list" class="card-grid"></div></section>' +
      '<section id="view-state" class="view" role="tabpanel" aria-labelledby="tab-state">' +
      '<h2><span class="material-symbols-outlined view-icon">database</span>Shared State</h2>' +
      '<div class="toolbar"><div class="search-wrapper"><span class="material-symbols-outlined search-icon">search</span><input type="search" id="state-filter" placeholder="Filter by key..." class="search-input" aria-label="Filter state" /></div></div>' +
      '<div id="state-table-container" class="table-scroll-wrapper"><table id="state-table" class="data-table" role="table"><thead><tr><th scope="col">Namespace</th><th scope="col">Key</th><th scope="col">Value</th><th scope="col">Updated By</th><th scope="col">Updated At</th></tr></thead><tbody id="state-tbody"></tbody></table></div>' +
      '</section>' +
      '<section id="view-feed" class="view" role="tabpanel" aria-labelledby="tab-feed">' +
      '<h2><span class="material-symbols-outlined view-icon">rss_feed</span>Activity Feed</h2>' +
      '<div class="toolbar"><div class="search-wrapper"><span class="material-symbols-outlined search-icon">filter_list</span>' +
      '<select id="feed-type-filter" class="search-input" style="max-width:200px" aria-label="Filter by type">' +
      '<option value="">All types</option><option value="commit">commit</option><option value="test_pass">test_pass</option><option value="test_fail">test_fail</option><option value="file_edit">file_edit</option><option value="task_complete">task_complete</option><option value="error">error</option><option value="custom">custom</option><option value="register">register</option><option value="message">message</option><option value="state_change">state_change</option><option value="handoff">handoff</option><option value="branch">branch</option>' +
      '</select></div></div><div id="feed-list" class="feed-timeline"></div>' +
      '</section>' +
      '</main></div>' +
      '<div id="cleanup-modal" class="modal-overlay hidden" role="dialog" aria-modal="true"><div class="modal">' +
      '<h3><span class="material-symbols-outlined panel-icon">mop</span>Clean Up</h3><p class="modal-desc">Choose what to remove:</p>' +
      '<div class="modal-options">' +
      '<button id="cleanup-stale" class="modal-option"><span class="material-symbols-outlined">auto_delete</span><div class="modal-option-text"><strong>Stale</strong><span>Remove offline agents and their messages, empty channels, and state entries</span></div></button>' +
      '<button id="cleanup-full" class="modal-option modal-option-danger"><span class="material-symbols-outlined">delete_forever</span><div class="modal-option-text"><strong>Full</strong><span>Remove all agents, messages, channels, and state entries</span></div></button>' +
      '</div><div class="modal-footer"><button id="cleanup-cancel" class="modal-cancel">Cancel</button></div></div></div>' +
      '<div id="toast-container" class="toast-container" aria-live="polite"></div>'
    );
  };
})();
