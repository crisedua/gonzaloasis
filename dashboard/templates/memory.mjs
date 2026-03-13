/**
 * dashboard/templates/memory.mjs — Memory search page
 */

import { layout, esc } from './layout.mjs';

export function memoryPage({ query, results, stats }) {
  const resultHtml = results.map(r => `
    <div class="search-result">
      <div class="search-result-path">${esc(r.path)} &middot; chars ${r.start_char}–${r.end_char}</div>
      <div class="search-result-text">${esc(r.text.length > 500 ? r.text.slice(0, 497) + '...' : r.text)}</div>
    </div>
  `).join('');

  return layout({
    title: 'Memory Search',
    activeTab: 'memory',
    content: `
      <h1 class="page-title">Memory Search</h1>
      <p class="page-subtitle">${stats.files} files indexed &middot; ${stats.chunks} searchable chunks</p>
      <form action="/d/memory" method="GET">
        <input type="text" name="q" class="search-box"
               placeholder="Search your memory..." value="${esc(query)}" autofocus>
      </form>
      <div id="search-results">
        ${query
          ? (results.length > 0
            ? `<p style="color:var(--text-dim); margin-bottom:12px">${results.length} result(s) for "${esc(query)}"</p>${resultHtml}`
            : `<div class="empty"><p>No results for "${esc(query)}"</p></div>`)
          : '<div class="empty"><p>Type a query to search across your memory files.</p></div>'}
      </div>
    `,
  });
}
