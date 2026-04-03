// =============================================================================
// agent-comm — UI utility helpers
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  // DOM morphing helper: diff-patches children instead of replacing innerHTML.
  // Preserves focus, scroll, CSS transitions — only changed nodes are touched.
  function morph(el, newInnerHTML) {
    var wrap = document.createElement(el.tagName);
    wrap.innerHTML = newInnerHTML;
    morphdom(el, wrap, { childrenOnly: true });
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

  function resolveAgentName(id) {
    var agents = AC.state.agents || [];
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].id === id) return agents[i].name;
    }
    if (AC.agentNameCache[id]) return AC.agentNameCache[id];
    return id ? id.substring(0, 8) : 'unknown';
  }

  function resolveChannelName(id) {
    var channels = AC.state.channels || [];
    for (var i = 0; i < channels.length; i++) {
      if (channels[i].id === id) return '#' + channels[i].name;
    }
    var archived = AC.state._archivedChannels || [];
    for (var j = 0; j < archived.length; j++) {
      if (archived[j].id === id) return '#' + archived[j].name;
    }
    return '#' + (id ? id.substring(0, 8) : 'channel');
  }

  // Export all utilities
  AC.morph = morph;
  AC.esc = esc;
  AC.escAttr = escAttr;
  AC.timeAgo = timeAgo;
  AC.renderMd = renderMd;
  AC.stripMd = stripMd;
  AC.parseCaps = parseCaps;
  AC.indexById = indexById;
  AC.findById = findById;
  AC.resolveAgentName = resolveAgentName;
  AC.resolveChannelName = resolveChannelName;

  function getInitials(name) {
    var parts = name.split(/[-_s]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
  }
  AC.getInitials = getInitials;
})();
