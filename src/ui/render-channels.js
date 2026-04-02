// =============================================================================
// agent-comm — Channel card rendering
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  function buildChannelCard(ch) {
    var msgCount = (AC.state.messages || []).filter(function (m) {
      return m.channel_id === ch.id;
    }).length;
    return (
      '<div class="card-title">#' +
      AC.esc(ch.name) +
      '</div>' +
      (ch.description ? '<div class="card-meta">' + AC.esc(ch.description) + '</div>' : '') +
      '<div class="card-meta">Created: ' +
      AC.timeAgo(ch.created_at) +
      '</div>' +
      '<div class="card-meta">' +
      msgCount +
      ' messages</div>' +
      (ch.archived_at ? '<div class="card-meta" style="color:var(--yellow)">Archived</div>' : '') +
      '<div class="card-action">View messages &rarr;</div>'
    );
  }

  function renderChannels() {
    var channels = AC.state.channels || [];
    var container = AC._root.getElementById('channels-list');

    if (channels.length === 0) {
      AC.morph(
        container,
        '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">forum</span>No channels created<div class="empty-state-hint">Use comm_channel({ action: "create" }) to add a channel</div></div>',
      );
      return;
    }

    AC.morph(
      container,
      channels
        .map(function (ch) {
          return (
            '<div class="card" data-channel-id="' +
            AC.escAttr(ch.id) +
            '">' +
            buildChannelCard(ch) +
            '</div>'
          );
        })
        .join(''),
    );
  }

  AC.renderChannels = renderChannels;
})();
