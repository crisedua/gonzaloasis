/**
 * search.mjs — DuckDuckGo web search via HTML scraping.
 *
 * Uses Node's built-in https module. No API key, no extra deps.
 *
 * Exported API:
 *   searchDuckDuckGo(query, limit = 5) → Array<{ title, url, snippet }>
 *
 * Parses html.duckduckgo.com/html — decodes the /l/?uddg= redirect URLs
 * to recover the real destination URLs.
 */

import https from 'node:https';
import http  from 'node:http';

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

function httpGet(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        return httpGet(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(15_000, () => { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
  });
}

// ─── HTML utilities ───────────────────────────────────────────────────────────

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(str) {
  return decodeHtmlEntities(str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Extracts the real destination URL from a DuckDuckGo /l/?uddg=... redirect.
 * Falls back to the raw href if parsing fails.
 */
function resolveHref(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (!m) return href;
  try { return decodeURIComponent(m[1]); } catch { return href; }
}

// ─── DDG HTML parser ──────────────────────────────────────────────────────────

/**
 * Parses the DDG HTML result page into an array of { title, url, snippet }.
 *
 * DDG HTML structure (simplified):
 *   <div class="result results_links …">
 *     <h2 class="result__title">
 *       <a class="result__a" href="/l/?uddg=URL&…">Title text</a>
 *     </h2>
 *     <a class="result__snippet" href="…">Snippet text</a>
 *   </div>
 */
function parseDDGResults(html, limit) {
  const results = [];

  // Split by result container — works for both web-result and results_links variants
  const blocks = html.split(/<div[^>]+class="result[ ">]/);

  for (let i = 1; i < blocks.length && results.length < limit; i++) {
    const block = blocks[i];

    // Title + URL
    const titleMatch = block.match(/class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    const url   = resolveHref(titleMatch[1]);
    const title = stripTags(titleMatch[2]);

    // Skip DDG's own pages and ads
    if (!url || url.includes('duckduckgo.com')) continue;
    if (!title) continue;

    // Snippet — can be either <a class="result__snippet"> or <div class="result__snippet">
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';

    results.push({ title, url, snippet });
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search DuckDuckGo and return up to `limit` results.
 *
 * @param {string} query
 * @param {number} limit  - max results to return (default 5)
 * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
 */
export async function searchDuckDuckGo(query, limit = 5) {
  const q    = encodeURIComponent(query);
  const url  = `https://html.duckduckgo.com/html/?q=${q}&kl=us-en`;
  const html = await httpGet(url);
  return parseDDGResults(html, limit);
}
