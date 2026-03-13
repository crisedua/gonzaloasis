/* dashboard.js — Minimal client-side interactivity */

(function () {
  'use strict';

  // ─── Debounced memory search ───────────────────────────────────────────────

  const searchBox = document.querySelector('.search-box');
  const resultsEl = document.getElementById('search-results');

  if (searchBox && resultsEl && window.location.pathname === '/d/memory') {
    let timer = null;

    searchBox.addEventListener('input', function () {
      clearTimeout(timer);
      const q = this.value.trim();
      if (!q) {
        resultsEl.innerHTML = '<div class="empty"><p>Type a query to search across your memory files.</p></div>';
        return;
      }

      timer = setTimeout(async () => {
        try {
          const res = await fetch('/api/memory/search?q=' + encodeURIComponent(q));
          const data = await res.json();

          if (data.length === 0) {
            resultsEl.innerHTML = '<div class="empty"><p>No results for "' + esc(q) + '"</p></div>';
            return;
          }

          resultsEl.innerHTML =
            '<p style="color:var(--text-dim); margin-bottom:12px">' + data.length + ' result(s)</p>' +
            data.map(function (r) {
              var text = r.text.length > 500 ? r.text.slice(0, 497) + '...' : r.text;
              return '<div class="search-result">' +
                '<div class="search-result-path">' + esc(r.path) + ' &middot; chars ' + r.start_char + '–' + r.end_char + '</div>' +
                '<div class="search-result-text">' + esc(text) + '</div>' +
                '</div>';
            }).join('');
        } catch (err) {
          resultsEl.innerHTML = '<div class="empty"><p>Search error: ' + esc(err.message) + '</p></div>';
        }
      }, 300);
    });

    // Prevent form submission (search is live)
    const form = searchBox.closest('form');
    if (form) {
      form.addEventListener('submit', function (e) { e.preventDefault(); });
    }
  }

  // ─── Async sections on Overview page ───────────────────────────────────────

  const todoistEl   = document.getElementById('todoist-section');
  const freedcampEl = document.getElementById('freedcamp-section');
  const emailsEl    = document.getElementById('emails-section');

  if (todoistEl) {
    fetchSection('/api/todoist', function (result) {
      if (result.error) return '<p class="card-meta">' + esc(result.error) + '</p>';
      if (!result.data || result.data.length === 0) return '<p class="card-meta">No tasks</p>';

      // Collect only priority tasks (P1/P2/P3) across all projects
      var priTasks = [];
      result.data.forEach(function (group) {
        group.tasks.forEach(function (t) {
          if (t.priority > 1) priTasks.push({ content: t.content, priority: t.priority, due: t.due, project: group.project });
        });
      });
      if (priTasks.length === 0) return '<p class="card-meta">No priority tasks</p>';

      // Sort by priority descending (4=P1 highest)
      priTasks.sort(function (a, b) { return b.priority - a.priority; });
      return priTasks.map(function (t) {
        var label = 'P' + (5 - t.priority);
        var cls = t.priority === 4 ? 'badge-paused' : t.priority === 3 ? 'badge-active' : 'badge-completed';
        var due = t.due ? ' <span class="card-meta">' + esc(t.due.date) + '</span>' : '';
        return '<div class="task-item"><span class="badge ' + cls + '">' + label + '</span> ' + esc(t.content) + due + '</div>';
      }).join('');
    }, todoistEl);
  }

  if (freedcampEl) {
    fetchSection('/api/freedcamp', function (result) {
      if (result.error) return '<p class="card-meta">' + esc(result.error) + '</p>';
      if (!result.data || result.data.length === 0) return '<p class="card-meta">No projects</p>';

      // Show projects with task counts
      return result.data.filter(function (g) {
        return g.tasks && g.tasks.length > 0;
      }).map(function (group) {
        var p = group.project || {};
        var name = p.project_name || p.name || 'Project';
        return '<div class="task-item"><strong>' + esc(name) + '</strong> <span class="card-meta">' + group.tasks.length + ' open tasks</span></div>';
      }).join('');
    }, freedcampEl);
  }

  if (emailsEl) {
    fetchSection('/api/emails', function (result) {
      if (result.error) return '<p class="card-meta">' + esc(result.error) + '</p>';
      if (!result.data || result.data.length === 0) return '<p class="card-meta">No recent emails</p>';

      return result.data.slice(0, 15).map(function (e) {
        const from = esc(e.from || '').replace(/&lt;[^&]*&gt;/g, '').trim();
        return '<div class="email-item">' +
          '<div class="email-subject">' + esc(e.subject) + '</div>' +
          '<div class="card-meta">' + from + '</div>' +
          '</div>';
      }).join('');
    }, emailsEl);
  }

  function fetchSection(url, renderer, el) {
    fetch(url)
      .then(function (res) {
        if (!res.ok) return { error: 'HTTP ' + res.status };
        return res.json();
      })
      .then(function (data) { el.innerHTML = renderer(data); })
      .catch(function (err) { el.innerHTML = '<p class="card-meta">Error: ' + esc(err.message) + '</p>'; });
  }

  // ─── Admin Panel: Test Service ──────────────────────────────────────────────

  window.testService = function (service) {
    var el = document.getElementById('test-' + service);
    if (!el) return;
    el.className = 'admin-test-result loading';
    el.textContent = 'Testing...';

    fetch('/api/config/test/' + service, { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok) {
          el.className = 'admin-test-result ok';
          el.textContent = data.info || 'Connected';
        } else {
          el.className = 'admin-test-result fail';
          el.textContent = 'Failed: ' + (data.error || 'Unknown error');
        }
      })
      .catch(function (err) {
        el.className = 'admin-test-result fail';
        el.textContent = 'Error: ' + err.message;
      });
  };

  // ─── Admin Panel: Edit/Hide Forms ─────────────────────────────────────────

  window.showEditForm = function (section) {
    var form = document.getElementById('edit-' + section);
    if (form) form.style.display = 'block';
  };

  window.hideEditForm = function (section) {
    var form = document.getElementById('edit-' + section);
    if (form) form.style.display = 'none';
  };

  // ─── Admin Panel: Disconnect Service ──────────────────────────────────────

  window.disconnectService = function (service) {
    if (!confirm('Disconnect ' + service + '? This will remove saved credentials.')) return;

    fetch('/api/config/disconnect/' + service, { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok) window.location.reload();
      })
      .catch(function (err) { alert('Error: ' + err.message); });
  };

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function esc(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
