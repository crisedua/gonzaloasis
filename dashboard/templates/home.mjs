/**
 * dashboard/templates/home.mjs — Overview page
 */

import { layout, badge, esc, fmtSize } from './layout.mjs';

export function homePage({ goalStats, activeGoals, recentDocs, memoryStats }) {
  const goalCards = activeGoals.slice(0, 6).map(g => `
    <a href="/d/goals/${g.id}" class="card" style="text-decoration:none">
      <div class="card-title">${esc(g.title)}</div>
      <div class="card-meta">${badge(g.status)} ${g.category ? `&middot; ${esc(g.category)}` : ''}</div>
    </a>
  `).join('');

  const docRows = recentDocs.slice(0, 8).map(d => `
    <tr>
      <td><a href="/d/documents/${encodeURIComponent(d.name)}">${esc(d.name)}</a></td>
      <td>${d.date || '—'}</td>
      <td>${fmtSize(d.size)}</td>
    </tr>
  `).join('');

  return layout({
    title: 'Overview',
    activeTab: 'home',
    content: `
      <h1 class="page-title">Overview</h1>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-number">${goalStats.active}</div>
          <div class="stat-label">Active Goals</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${goalStats.completed}</div>
          <div class="stat-label">Completed</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${goalStats.total}</div>
          <div class="stat-label">Total Goals</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${memoryStats.files}</div>
          <div class="stat-label">Memory Files</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${memoryStats.chunks}</div>
          <div class="stat-label">Search Chunks</div>
        </div>
      </div>

      <div class="grid-3" style="margin-bottom:32px">
        <div>
          <h2 class="page-title" style="font-size:1.1rem">Todoist Tasks</h2>
          <div id="todoist-section" class="async-section">
            <p class="card-meta">Loading...</p>
          </div>
        </div>
        <div>
          <h2 class="page-title" style="font-size:1.1rem">Freedcamp Tasks</h2>
          <div id="freedcamp-section" class="async-section">
            <p class="card-meta">Loading...</p>
          </div>
        </div>
        <div>
          <h2 class="page-title" style="font-size:1.1rem">Recent Emails (7 days)</h2>
          <div id="emails-section" class="async-section">
            <p class="card-meta">Loading...</p>
          </div>
        </div>
      </div>

      <h2 class="page-title" style="font-size:1.2rem">Active Goals</h2>
      ${activeGoals.length > 0
        ? `<div class="grid-3">${goalCards}</div>`
        : '<div class="empty"><p>No active goals</p></div>'}

      <h2 class="page-title" style="font-size:1.2rem; margin-top:32px">Recent Documents</h2>
      ${recentDocs.length > 0
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Name</th><th>Date</th><th>Size</th></tr></thead>
            <tbody>${docRows}</tbody>
           </table></div>`
        : '<div class="empty"><p>No documents yet</p></div>'}
    `,
  });
}
