// =============================================================================
// agent-comm — Agent card rendering
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  function heartbeatFreshness(dateStr) {
    if (!dateStr) return { text: '', cls: '' };
    var now = Date.now();
    var then = new Date(
      dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'),
    ).getTime();
    var seconds = Math.max(0, Math.floor((now - then) / 1000));
    var text = AC.timeAgo(dateStr);
    var cls = seconds < 30 ? 'hb-fresh' : seconds < 120 ? 'hb-warm' : 'hb-stale';
    return { text: text, cls: cls };
  }

  function isAgentStuck(a) {
    if (a.status === 'offline') return false;
    if (!a.last_activity) return false;
    var now = Date.now();
    var actTime = new Date(
      a.last_activity + (a.last_activity.includes('Z') || a.last_activity.includes('+') ? '' : 'Z'),
    ).getTime();
    var minutes = Math.floor((now - actTime) / 60000);
    return minutes >= 10;
  }

  function buildAgentCard(a) {
    var caps = AC.parseCaps(a);
    var msgCount = (AC.state.messages || []).filter(function (m) {
      return m.from_agent === a.id || m.to_agent === a.id;
    }).length;
    var hb = heartbeatFreshness(a.last_heartbeat);
    var stuck = isAgentStuck(a);
    return (
      '<div class="card-title"><span class="status-dot ' +
      AC.esc(a.status) +
      '"></span>' +
      AC.esc(a.name) +
      (stuck
        ? ' <span class="stuck-badge"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px">hourglass_top</span> idle ' +
          AC.timeAgo(a.last_activity) +
          '</span>'
        : '') +
      '</div>' +
      (a.status_text
        ? '<div class="card-meta status-text">' + AC.esc(a.status_text) + '</div>'
        : '') +
      '<div class="card-meta">Status: ' +
      AC.esc(a.status) +
      ' &middot; Heartbeat: <span class="' +
      hb.cls +
      '">' +
      hb.text +
      '</span></div>' +
      (a.last_activity
        ? '<div class="card-meta">Last activity: ' + AC.timeAgo(a.last_activity) + '</div>'
        : '') +
      '<div class="card-meta">Registered: ' +
      AC.timeAgo(a.registered_at) +
      '</div>' +
      (msgCount > 0 ? '<div class="card-meta">' + msgCount + ' messages</div>' : '') +
      '<div style="margin-top:8px">' +
      caps
        .map(function (c) {
          return '<span class="capability-tag">' + AC.esc(c) + '</span>';
        })
        .join('') +
      '</div>' +
      (function () {
        var skills = a.skills || [];
        if (skills.length === 0) return '';
        return (
          '<div style="margin-top:4px">' +
          skills
            .map(function (s) {
              var tags = (s.tags || []).join(', ');
              return (
                '<span class="skill-pill" title="' +
                AC.escAttr(tags) +
                '">' +
                AC.esc(s.name) +
                '</span>'
              );
            })
            .join('') +
          '</div>'
        );
      })() +
      '<div class="card-action">View messages &rarr;</div>'
    );
  }

  function renderAgents() {
    var agents = AC.state.agents || [];
    var container = AC._root.getElementById('agents-list');

    if (agents.length === 0) {
      AC.morph(
        container,
        '<div class="empty-state"><span class="material-symbols-outlined empty-state-icon">smart_toy</span>No agents registered<div class="empty-state-hint">Use comm_register to connect an agent</div></div>',
      );
      return;
    }

    AC.morph(
      container,
      agents
        .map(function (a) {
          return (
            '<div class="card agent-card" data-agent-id="' +
            AC.escAttr(a.id) +
            '">' +
            buildAgentCard(a) +
            '</div>'
          );
        })
        .join(''),
    );
  }

  AC.renderAgents = renderAgents;
})();
