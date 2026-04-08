// =============================================================================
// agent-comm dashboard — render-bench.js
//
// Renders the Bench tab from the /api/bench endpoint. Each pilot is shown
// as a card with the conditions side-by-side. Naive vs hooked deltas are
// computed and highlighted so the visual story (cheaper, faster) is obvious.
//
// Loaded via script tag in index.html before app.js.
// =============================================================================

(function () {
  'use strict';

  var AC = (window.AC = window.AC || {});

  function pct(n) {
    return (n * 100).toFixed(1) + '%';
  }
  function dollars(n) {
    return '$' + (Math.round(n * 1000) / 1000).toFixed(3);
  }
  function delta(a, b, opts) {
    // Returns a span describing the delta from a (baseline) -> b (treatment).
    if (!isFinite(a) || !isFinite(b) || a === 0) return '';
    var rel = (b - a) / a;
    var betterIsLower = (opts && opts.betterIsLower) !== false;
    var isWin = betterIsLower ? rel < 0 : rel > 0;
    var sign = rel < 0 ? '' : '+';
    var cls = isWin ? 'bench-delta-win' : 'bench-delta-lose';
    return ' <span class="' + cls + '">(' + sign + (rel * 100).toFixed(0) + '%)</span>';
  }

  function metricRow(label, naive, hooked, fmt, betterIsLower) {
    var html = '<tr><td class="bench-metric-label">' + AC.esc(label) + '</td>';
    if (naive != null) html += '<td>' + fmt(naive) + '</td>';
    else html += '<td class="bench-na">—</td>';
    if (hooked != null) {
      html += '<td>' + fmt(hooked);
      if (naive != null) html += delta(naive, hooked, { betterIsLower: betterIsLower });
      html += '</td>';
    } else {
      html += '<td class="bench-na">—</td>';
    }
    html += '</tr>';
    return html;
  }

  function renderPilot(p) {
    var naiveCond = (p.conditions || []).find(function (c) {
      return c.label === 'naive';
    });
    var hookedCond = (p.conditions || []).find(function (c) {
      return c.label === 'hooked';
    });
    var pipelineCond = (p.conditions || []).find(function (c) {
      return c.label === 'pipeline-claim';
    });

    var n = naiveCond && naiveCond.report;
    var h = hookedCond && hookedCond.report;
    var pc = pipelineCond && pipelineCond.report;

    var html = '<article class="bench-pilot">';
    html += '<header class="bench-pilot-header">';
    html += '<h3>' + AC.esc(p.name) + '</h3>';
    html += '<span class="bench-timestamp">' + AC.esc(p.timestamp || '') + '</span>';
    html += '</header>';
    html += '<p class="bench-pilot-desc">' + AC.esc(p.description || '') + '</p>';

    if (pc && !n && !h) {
      // Single-condition pilot (e.g. async-handoff)
      html +=
        '<table class="bench-table"><thead><tr><th>metric</th><th>pipeline-claim</th></tr></thead><tbody>';
      html += metricRow('coverage', null, pc.mean_unique_units, function (x) {
        return x.toFixed(1);
      });
      html += metricRow(
        'wall (s)',
        null,
        pc.mean_wall_seconds,
        function (x) {
          return x.toFixed(1) + 's';
        },
        true,
      );
      html += metricRow('cost', null, pc.mean_total_cost_usd, dollars, true);
      html += metricRow(
        'units / $',
        null,
        pc.units_per_dollar,
        function (x) {
          return x.toFixed(2);
        },
        false,
      );
      html += metricRow('parallelism', null, pc.mean_parallelism, function (x) {
        return x.toFixed(2) + 'x';
      });
      html += '</tbody></table>';
    } else {
      html +=
        '<table class="bench-table"><thead><tr><th>metric</th><th>naive</th><th>hooked</th></tr></thead><tbody>';
      html += metricRow(
        'coverage',
        n && n.mean_unique_units,
        h && h.mean_unique_units,
        function (x) {
          return x.toFixed(1);
        },
      );
      html += metricRow(
        'wall (s)',
        n && n.mean_wall_seconds,
        h && h.mean_wall_seconds,
        function (x) {
          return x.toFixed(1) + 's';
        },
        true,
      );
      html += metricRow(
        'cost',
        n && n.mean_total_cost_usd,
        h && h.mean_total_cost_usd,
        dollars,
        true,
      );
      html += metricRow(
        'units / $',
        n && n.units_per_dollar,
        h && h.units_per_dollar,
        function (x) {
          return x.toFixed(2);
        },
        false,
      );
      html += metricRow(
        'file collisions',
        n && n.file_collision_rate,
        h && h.file_collision_rate,
        pct,
        true,
      );
      html += metricRow(
        'parallelism',
        n && n.mean_parallelism,
        h && h.mean_parallelism,
        function (x) {
          return x.toFixed(2) + 'x';
        },
      );
      html += '</tbody></table>';
    }

    html += '</article>';
    return html;
  }

  AC.renderBench = function () {
    var listEl = AC._root.getElementById('bench-list');
    if (!listEl) return;
    AC._fetch('/api/bench')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.pilots || data.pilots.length === 0) {
          listEl.innerHTML =
            '<div class="empty-state"><span class="material-symbols-outlined">science</span>' +
            '<p>No bench results yet.</p>' +
            '<p class="empty-hint">Run <code>npm run bench:run -- --real</code> from the agent-comm root to populate this view.</p>' +
            (data && data.note ? '<p class="empty-hint">' + AC.esc(data.note) + '</p>' : '') +
            '</div>';
          return;
        }
        listEl.innerHTML = data.pilots
          .map(function (p) {
            return renderPilot(p);
          })
          .join('');
      })
      .catch(function (err) {
        listEl.innerHTML =
          '<div class="empty-state"><p>Failed to load bench results: ' +
          AC.esc(String(err && err.message ? err.message : err)) +
          '</p></div>';
      });
  };
})();
