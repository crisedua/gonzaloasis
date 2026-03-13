/**
 * dashboard/templates/history.mjs — Daily log viewer
 */

import { layout, esc, md } from './layout.mjs';

export function historyPage({ logs, selectedDate, content }) {
  const dateLinks = logs.map(l => `
    <a href="/d/history/${l.date}" class="${l.date === selectedDate ? 'active' : ''}">${l.date}</a>
  `).join('');

  const body = content
    ? md(content)
    : '<div class="empty"><p>Select a date to view its log.</p></div>';

  return layout({
    title: 'Session History',
    activeTab: 'history',
    content: `
      <h1 class="page-title">Session History</h1>
      ${logs.length > 0
        ? `<div class="history-layout">
            <div class="history-dates">${dateLinks}</div>
            <div class="history-content">${body}</div>
           </div>`
        : '<div class="empty"><p>No session logs yet.</p></div>'}
    `,
  });
}
