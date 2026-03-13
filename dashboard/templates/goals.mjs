/**
 * dashboard/templates/goals.mjs — Goals list + detail pages
 */

import { layout, badge, esc, md } from './layout.mjs';

export function goalsPage({ goals }) {
  const grouped = { active: [], paused: [], completed: [], archived: [] };
  for (const g of goals) {
    (grouped[g.status] || grouped.active).push(g);
  }

  let sections = '';
  for (const [status, items] of Object.entries(grouped)) {
    if (items.length === 0) continue;
    const rows = items.map(g => `
      <tr>
        <td>${g.id}</td>
        <td><a href="/d/goals/${g.id}">${esc(g.title)}</a></td>
        <td>${badge(g.status)}</td>
        <td>${esc(g.category) || '—'}</td>
        <td>${g.last_reviewed || '—'}</td>
      </tr>
    `).join('');

    sections += `
      <h2 class="page-title" style="font-size:1.1rem; margin-top:24px; text-transform:capitalize">${status} (${items.length})</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Goal</th><th>Status</th><th>Category</th><th>Last Reviewed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    `;
  }

  return layout({
    title: 'Goals',
    activeTab: 'goals',
    content: `
      <h1 class="page-title">Goals</h1>
      ${sections || '<div class="empty"><p>No goals found. Run <code>node goals_manager.mjs index</code> to sync.</p></div>'}
    `,
  });
}

export function goalDetailPage({ goal }) {
  if (!goal) {
    return layout({
      title: 'Goal Not Found',
      activeTab: 'goals',
      content: '<div class="empty"><p>Goal not found.</p></div>',
    });
  }

  const sections = [
    { label: 'Category', value: goal.category },
    { label: 'Why', value: goal.why },
    { label: 'Metrics', value: goal.metrics },
    { label: 'Actions', value: goal.actions },
    { label: 'Balance', value: goal.balance },
    { label: 'Last Reviewed', value: goal.last_reviewed },
    { label: 'Updated', value: goal.updated_at },
  ].filter(s => s.value).map(s => `
    <div class="goal-section">
      <div class="goal-section-title">${s.label}</div>
      <div class="goal-section-content">${md(s.value)}</div>
    </div>
  `).join('');

  return layout({
    title: goal.title,
    activeTab: 'goals',
    content: `
      <p style="margin-bottom:8px"><a href="/d/goals">&larr; Back to Goals</a></p>
      <h1 class="page-title">${esc(goal.title)} ${badge(goal.status)}</h1>
      ${sections}
    `,
  });
}
