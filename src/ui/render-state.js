// =============================================================================
// agent-comm — State table rendering
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  function renderState() {
    var entries = AC.state.state || [];
    var tbody = AC._root.getElementById('state-tbody');
    var filterInput = AC._root.getElementById('state-filter');
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
      AC.morph(
        tbody,
        '<tr><td colspan="5" class="empty-state">' +
          (filter
            ? 'No matching entries'
            : '<span class="material-symbols-outlined empty-state-icon">database</span>No shared state') +
          '</td></tr>',
      );
      return;
    }

    AC.morph(
      tbody,
      filtered
        .map(function (e) {
          return (
            '<tr>' +
            '<td>' +
            AC.esc(e.namespace) +
            '</td>' +
            '<td>' +
            AC.esc(e.key) +
            '</td>' +
            '<td class="value-cell" title="' +
            AC.escAttr(e.value) +
            '">' +
            AC.esc(e.value) +
            '</td>' +
            '<td>' +
            AC.esc(AC.resolveAgentName(e.updated_by)) +
            '</td>' +
            '<td>' +
            AC.timeAgo(e.updated_at) +
            '</td>' +
            '</tr>'
          );
        })
        .join(''),
    );
  }

  AC.renderState = renderState;
})();
