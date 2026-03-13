/**
 * dashboard/templates/calendar.mjs — Calendar events page
 */

import { layout, esc } from './layout.mjs';

export function calendarPage({ events, error }) {
  if (error) {
    return layout({
      title: 'Calendar',
      activeTab: 'calendar',
      content: `
        <h1 class="page-title">Calendar</h1>
        <div class="empty"><p>${esc(error)}</p></div>
      `,
    });
  }

  const rows = events.map(e => {
    const start = e.start?.dateTime || e.start?.date || '';
    const displayDate = start ? new Date(start).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }) : '—';

    return `
      <tr>
        <td><strong>${esc(e.summary || 'Untitled')}</strong></td>
        <td>${displayDate}</td>
        <td>${esc(e.location || '')}</td>
        <td>${e.htmlLink ? `<a href="${esc(e.htmlLink)}" target="_blank">Open</a>` : ''}</td>
      </tr>
    `;
  }).join('');

  return layout({
    title: 'Calendar',
    activeTab: 'calendar',
    content: `
      <h1 class="page-title">Upcoming Events</h1>
      ${events.length > 0
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Event</th><th>When</th><th>Location</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
           </table></div>`
        : '<div class="empty"><p>No upcoming events.</p></div>'}
    `,
  });
}
