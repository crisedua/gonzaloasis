/**
 * clipper.mjs — URL clip-to-Evernote + local backup.
 *
 * Flow when a URL is detected in a Telegram message:
 *   1. Fetch the page (built-in https, redirect-following)
 *   2. Extract readable content via @mozilla/readability + linkedom
 *      (same pattern as OpenClaw's web-fetch-utils.ts)
 *   3. Save locally to documents/clipped/YYYY-MM-DD-<slug>.md  (always)
 *   4. Save to Evernote if EVERNOTE_TOKEN is set
 *   5. Return { title, localPath, evernoteUrl } for the reply
 *
 * Required .env key:
 *   EVERNOTE_TOKEN=your_developer_token
 *   Get it at: https://www.evernote.com/api/DeveloperToken.action
 *
 * Optional:
 *   EVERNOTE_SANDBOX=true   (use sandbox.evernote.com for testing)
 */

import https      from 'node:https';
import http       from 'node:http';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Readability } from '@mozilla/readability';
import { parseHTML }   from 'linkedom';
import Evernote        from 'evernote';

const ROOT      = resolve('.');
const CLIP_DIR  = join(ROOT, 'documents', 'clipped');

const MAX_CHARS = 50_000;   // cap extracted text (matches OpenClaw's DEFAULT_FETCH_MAX_CHARS)
const TIMEOUT   = 20_000;   // ms

// ─── URL detection ────────────────────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"{}|\\^`\[\]]+/i;

/**
 * Returns the first HTTP/HTTPS URL found in the text, or null.
 * Strips trailing punctuation that might follow a URL in prose.
 */
export function detectUrl(text) {
  const m = text.match(URL_RE);
  if (!m) return null;
  return m[0].replace(/[.,!?;:'")\]]+$/, '');
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

function httpGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        return httpGet(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (res.statusCode && res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(TIMEOUT, () => { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
  });
}

// ─── Content extraction (OpenClaw pattern) ────────────────────────────────────

/**
 * Uses @mozilla/readability + linkedom to extract the main article content.
 * Falls back to stripping all tags when readability finds nothing.
 * Mirrors OpenClaw's extractReadableContent in web-fetch-utils.ts.
 */
function extractContent(html, url) {
  let title   = '';
  let content = '';

  // Try Readability first (best quality)
  try {
    const { document } = parseHTML(html);
    const reader  = new Readability(document, { charThreshold: 100 });
    const article = reader.parse();
    if (article) {
      title   = article.title || '';
      content = article.textContent || '';
    }
  } catch {
    // fall through to raw strip
  }

  // Fallback: strip tags
  if (!content.trim()) {
    // Extract <title>
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();

    content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s{3,}/g, '\n\n')
      .trim();
  }

  // Derive title from URL if still missing
  if (!title) {
    try { title = new URL(url).hostname; } catch { title = url; }
  }

  // Sanitize title for use as a filename / Evernote note title
  const safeTitle = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  return {
    title:   safeTitle,
    content: content.slice(0, MAX_CHARS),
  };
}

// ─── Local save ───────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function saveLocally(title, content, sourceUrl) {
  if (!existsSync(CLIP_DIR)) mkdirSync(CLIP_DIR, { recursive: true });

  const date     = new Date().toISOString().slice(0, 10);
  const slug     = slugify(title) || slugify(new URL(sourceUrl).hostname);
  const filename = `${date}-${slug}.md`;
  const filePath = join(CLIP_DIR, filename);

  const markdown = [
    `# ${title}`,
    ``,
    `**Source:** ${sourceUrl}`,
    `**Clipped:** ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    ``,
    `---`,
    ``,
    content,
  ].join('\n');

  writeFileSync(filePath, markdown, 'utf8');
  return `documents/clipped/${filename}`;
}

// ─── Evernote save ────────────────────────────────────────────────────────────

function textToEnml(content, sourceUrl) {
  const date    = new Date().toLocaleString('en-US', { hour12: false });
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const paras = escaped
    .split(/\n{2,}/)
    .filter(p => p.trim())
    .map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('\n');

  const safeUrl = sourceUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">',
    '<en-note>',
    `<div><b>Source:</b> <a href="${safeUrl}">${safeUrl.slice(0, 120)}</a></div>`,
    `<div><b>Clipped:</b> ${date}</div>`,
    '<hr/>',
    paras,
    '</en-note>',
  ].join('\n');
}

async function saveToEvernote(title, content, sourceUrl) {
  const token   = process.env.EVERNOTE_TOKEN;
  const sandbox = process.env.EVERNOTE_SANDBOX === 'true';
  if (!token) return null;

  const client    = new Evernote.Client({ token, sandbox });
  const noteStore = await client.getNoteStore();

  const note       = new Evernote.Types.Note();
  note.title       = title.slice(0, 255);
  note.content     = textToEnml(content, sourceUrl);
  note.attributes  = new Evernote.Types.NoteAttributes();
  note.attributes.sourceURL = sourceUrl.slice(0, 4096);

  const created = await noteStore.createNote(note);
  return created.guid ?? null;
}

// ─── LinkedIn detection ──────────────────────────────────────────────────────

const LINKEDIN_RE = /\bhttps?:\/\/(www\.)?linkedin\.com\/(posts|feed\/update|pulse)\//i;

/**
 * Returns true if the URL is a LinkedIn post/article.
 */
export function isLinkedInUrl(url) {
  return LINKEDIN_RE.test(url);
}

// ─── LinkedIn oEmbed ─────────────────────────────────────────────────────────

/**
 * Fetch LinkedIn post content via oEmbed API (no auth needed, public posts).
 * Returns { title, html, authorName } or null if oEmbed fails.
 */
async function fetchLinkedInOEmbed(postUrl) {
  const oembedUrl = `https://www.linkedin.com/oembed?url=${encodeURIComponent(postUrl)}&format=json`;
  const raw = await httpGet(oembedUrl);
  const data = JSON.parse(raw);

  if (!data || !data.html) return null;

  // oEmbed returns an HTML iframe/blockquote — extract the text content
  const { document } = parseHTML(data.html);
  const text = document.body?.textContent?.trim() || '';

  return {
    title: data.title || `LinkedIn post by ${data.author_name || 'unknown'}`,
    authorName: data.author_name || 'unknown',
    content: text,
  };
}

/**
 * Try to extract LinkedIn post content by fetching the page directly.
 * LinkedIn sometimes returns partial content in meta tags even without auth.
 */
async function fetchLinkedInDirect(postUrl) {
  const html = await httpGet(postUrl);

  // Try og:description meta tag — LinkedIn often puts post text here
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)?.[1]
    || html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i)?.[1];
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1]
    || html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i)?.[1];

  if (!ogDesc && !ogTitle) return null;

  // Decode HTML entities
  const decode = (s) => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');

  const title = ogTitle ? decode(ogTitle) : 'LinkedIn Post';
  const content = ogDesc ? decode(ogDesc) : '';

  return { title, authorName: title.split(' on LinkedIn')[0] || 'unknown', content };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Clip a LinkedIn post: oEmbed → direct scrape → save locally + Evernote.
 *
 * @param {string} url — LinkedIn post URL
 * @returns {{ title, authorName, localPath, evernoteGuid|null, wordCount }}
 */
export async function clipLinkedIn(url) {
  // Try oEmbed first (best quality for public posts)
  let result = null;
  try {
    result = await fetchLinkedInOEmbed(url);
  } catch (err) {
    console.log('[linkedin clip] oEmbed failed:', err.message);
  }

  // Fallback: direct fetch + og:description meta tags
  if (!result || !result.content) {
    try {
      result = await fetchLinkedInDirect(url);
    } catch (err) {
      console.log('[linkedin clip] direct fetch failed:', err.message);
    }
  }

  if (!result || !result.content) {
    throw new Error('Could not extract LinkedIn post content. The post may be private or require authentication.');
  }

  const wordCount = result.content.trim().split(/\s+/).length;
  const localPath = saveLocally(result.title, result.content, url);

  let evernoteGuid = null;
  try {
    evernoteGuid = await saveToEvernote(result.title, result.content, url);
  } catch (err) {
    console.error('[evernote]', err.message);
  }

  return {
    title: result.title,
    authorName: result.authorName,
    localPath,
    evernoteGuid,
    wordCount,
  };
}

/**
 * Full clip pipeline: fetch → extract → save locally → save to Evernote.
 *
 * @param {string} url
 * @returns {{ title, localPath, evernoteGuid|null, wordCount }}
 */
export async function clipUrl(url) {
  const html = await httpGet(url);
  const { title, content } = extractContent(html, url);

  const wordCount = content.trim().split(/\s+/).length;
  const localPath = saveLocally(title, content, url);

  let evernoteGuid = null;
  try {
    evernoteGuid = await saveToEvernote(title, content, url);
  } catch (err) {
    // Log but don't fail — local save already happened
    console.error('[evernote]', err.message);
  }

  return { title, localPath, evernoteGuid, wordCount };
}
