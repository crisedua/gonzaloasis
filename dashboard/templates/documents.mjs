/**
 * dashboard/templates/documents.mjs — Documents listing + viewer
 */

import { layout, esc, fmtSize, md } from './layout.mjs';

export function documentsPage({ documents }) {
  const rows = documents.map(d => `
    <tr>
      <td><a href="/d/documents/${encodeURIComponent(d.name)}">${esc(d.name)}</a></td>
      <td>${d.date || '—'}</td>
      <td>${fmtSize(d.size)}</td>
    </tr>
  `).join('');

  return layout({
    title: 'Documents',
    activeTab: 'documents',
    content: `
      <h1 class="page-title">Documents</h1>
      ${documents.length > 0
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Name</th><th>Date</th><th>Size</th></tr></thead>
            <tbody>${rows}</tbody>
           </table></div>`
        : '<div class="empty"><p>No documents yet.</p></div>'}
    `,
  });
}

export function documentViewPage({ filename, content }) {
  if (!content) {
    return layout({
      title: 'Document Not Found',
      activeTab: 'documents',
      content: '<div class="empty"><p>Document not found.</p></div>',
    });
  }

  return layout({
    title: filename,
    activeTab: 'documents',
    content: `
      <p style="margin-bottom:8px"><a href="/d/documents">&larr; Back to Documents</a></p>
      <h1 class="page-title">${esc(filename)}</h1>
      <div class="history-content">${md(content)}</div>
    `,
  });
}
