#!/usr/bin/env node
/**
 * bot.mjs — Telegram adapter for the second brain.
 *
 * Uses the `claude` CLI via subprocess instead of the API SDK.
 * No API key needed — uses your existing Claude Max subscription.
 *
 * Every message flow:
 *   1. Receive message from Telegram
 *   2. Load soul.md + user.md + memory.md + today's log fresh
 *   3. Format conversation history as text, pipe to `claude --print` via stdin
 *   4. Return Claude's reply to Telegram
 *   5. Append the exchange to today's daily log
 *   6. Re-index memory.db in the background
 *
 * Commands:
 *   /start              — welcome + status
 *   /clear              — wipe conversation history for this chat
 *   /status             — show which memory files are loaded
 *   /search <query>     — FTS5 search across all indexed memory
 *   /remember <text>    — append a durable fact directly to memory.md
 *
 * Setup:
 *   cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN + ALLOWED_TELEGRAM_USER_ID
 *   npm install
 *   node bot.mjs
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { startHeartbeat } from './heartbeat.mjs';
import { startScheduler, parseScheduleConfig } from './scheduler.mjs';
import { searchDuckDuckGo } from './search.mjs';
import { detectUrl, clipUrl, isLinkedInUrl, clipLinkedIn } from './clipper.mjs';
import { getFreedcampContext, getAllTasks, getProjects as getFcProjects, getTasks as getFcTasks, completeTask as fcCompleteTask } from './freedcamp.mjs';
import { getTodoistContext, getProjects as getTdProjects, getTasksForProject, closeTask } from './todoist.mjs';
import { isAuthorised as isGoogleAuthorised, getAuthUrl, exchangeCode } from './google-auth.mjs';
import { getUnread, searchEmails, getEmail, sendEmail, replyEmail, getEmailContext } from './gmail.mjs';
import { listRecent, searchFiles, readFile, createDoc, updateDoc } from './drive.mjs';
import { createPresentation } from './slides.mjs';
import { getUpcomingEvents, getTodayEvents, searchEvents as searchCalEvents, getEvent, createEvent, deleteEvent } from './calendar.mjs';
import { startDashboard } from './dashboard/server.mjs';
import { initConfigTable, loadConfigIntoEnv, setConfig, deleteConfig, getConfig } from './dashboard/config.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readFileSync, existsSync, appendFileSync,
  writeFileSync, mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// ─── Configuration ────────────────────────────────────────────────────────────

const ROOT = resolve('.');
const MEMORY_DIR = join(ROOT, 'memory');
const DOCS_DIR = join(ROOT, 'documents');

const {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_TELEGRAM_USER_ID,
  CLAUDE_MODEL = 'opus',   // CLI alias: opus | sonnet | haiku, or full model name
  MAX_HISTORY_TURNS = '20',
} = process.env;

const MAX_HISTORY = parseInt(MAX_HISTORY_TURNS, 10) * 2; // turns × 2 = messages
const TG_LIMIT = 4096;
/** Returns the configured timezone (reads live — may change after DB config load). */
function tz() { return process.env.TIMEZONE || process.env.CALENDAR_TIMEZONE || 'America/Santiago'; }

/** Returns current date string (YYYY-MM-DD) in configured timezone. */
function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz() });
}

/** Returns current Date object adjusted to configured timezone. */
function nowInTz() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz() }));
}

/**
 * Uploads a document to Google Drive as a Google Doc.
 * Returns the webViewLink on success, null on failure (non-blocking).
 */
async function uploadToDrive(title, content) {
  try {
    const docId = await createDoc(title, content);
    return `https://docs.google.com/document/d/${docId}/edit`;
  } catch (err) {
    console.error('Drive upload failed:', err.message);
    return null;
  }
}

// ─── Load config from DB (fills process.env gaps) ────────────────────────────

try {
  const { DatabaseSync } = await import('node:sqlite');
  const _cfgDb = new DatabaseSync(join(ROOT, 'memory.db'));
  initConfigTable(_cfgDb);
  loadConfigIntoEnv(_cfgDb);
  _cfgDb.close();
} catch (err) {
  // DB may not exist yet on fresh install — that's fine
  if (err.code !== 'SQLITE_CANTOPEN') {
    console.warn('[config] Could not load config from DB:', err.message);
  }
}

// Re-read env vars after DB merge (they may have been populated from config table)
const TELEGRAM_BOT_TOKEN_LIVE = process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_LIVE = process.env.ALLOWED_TELEGRAM_USER_ID || ALLOWED_TELEGRAM_USER_ID;

// ─── Startup validation ───────────────────────────────────────────────────────

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3456', 10);
const DASHBOARD_URL  = process.env.DASHBOARD_URL || `http://localhost:${DASHBOARD_PORT}`;

if (!TELEGRAM_BOT_TOKEN_LIVE) {
  console.log('No TELEGRAM_BOT_TOKEN configured.');
  console.log(`Starting in setup mode — visit http://localhost:${DASHBOARD_PORT}/setup to configure.`);

  // Start dashboard in setup-only mode
  startDashboard({ port: DASHBOARD_PORT, rootDir: ROOT, getUpcomingEvents, services: {} });

  // Block here forever — keeps process alive, prevents rest of file from running.
  // SIGINT/SIGTERM will exit the process via default Node.js behavior.
  await new Promise(() => {});
}

if (!ALLOWED_USER_LIVE) {
  console.warn('[warn] ALLOWED_TELEGRAM_USER_ID is not set — bot will respond to anyone.');
}

// ─── Telegram client ──────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN_LIVE, { polling: true });

// ─── In-memory state ──────────────────────────────────────────────────────────

// Per-chat conversation history: chatId → Array<{ role: 'user'|'assistant', content: string }>
const histories = new Map();

// Per-chat extra context injected by skill commands (/goals, /morning)
// Cleared by /clear. Merged into every callClaude for that chat.
const sessionContexts = new Map();

// Prevent overlapping requests for the same chat
const processing = new Set();

// ─── Goal wizard state ────────────────────────────────────────────────────────

// chatId → 'active' when inside the /newgoal wizard
const goalWizardState = new Map();

// chatId → true when inside a /goals review session
const goalReviewState = new Map();

// chatId → expert name when inside a super-team expert session
const expertSessionState = new Map();

// chatId → { title, why, metrics, timeframe, actions[] } when a proposal is pending /confirm
const pendingGoalProposals = new Map();

// ─── LinkedIn wizard state ─────────────────────────────────────────────────────

// chatId → 'active' when inside the /linkedin wizard
const linkedinWizardState = new Map();

// chatId → { hook, body, cta, hashtags, angle } when a post is pending /postit
const pendingLinkedinPosts = new Map();

// ─── Memory loader ────────────────────────────────────────────────────────────

function readSafe(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Builds the memory context block.
 * Called fresh on every message — edits to memory files take effect immediately.
 * Returned as a string that gets embedded directly into stdin (not a CLI arg),
 * so there are no shell-escaping concerns regardless of markdown content.
 */
function buildMemoryContext({ includeSkill = true } = {}) {
  const today = todayStr();

  const soul = readSafe(join(ROOT, 'soul.md'));
  const user = readSafe(join(ROOT, 'user.md'));
  const memory = readSafe(join(ROOT, 'memory.md'));
  const skill = includeSkill ? readSafe(join(ROOT, 'skill.md')) : null;
  const log = readSafe(join(MEMORY_DIR, `${today}.md`));

  const sections = [
    soul && `# soul.md\n\n${soul}`,
    user && `# user.md\n\n${user}`,
    memory && `# memory.md\n\n${memory}`,
    skill && `# skill.md\n\n${skill}`,
    log && `# memory/${today}.md  (today's log)\n\n${log}`,
  ].filter(Boolean);

  const memoryBlock = sections.length > 0
    ? sections.join('\n\n---\n\n')
    : '(No memory files found. The memory system may not be initialized.)';

  return [
    'You are an AI second brain, accessed through Telegram by your user.',
    'The files below define who you are, who you are talking to, and what you remember.',
    'Read them carefully before every reply.',
    '',
    memoryBlock,
    '',
    '---',
    '',
    'Telegram reply guidelines:',
    '- Be concise. This is a chat interface, not a document editor.',
    '- Telegram renders *bold*, _italic_, `inline code`, and ```code blocks```. Use sparingly.',
    '- Do not repeat the question back. Answer directly.',
    '- Every exchange is automatically logged to today\'s daily log after you reply.',
    '- If the user asks you to remember something, confirm exactly what was saved.',
    '- You cannot edit files directly. If a session context provides a structured output format, use that format exactly.',
    '- Otherwise, for goal changes tell the user to use: /newgoal, /gupdate <id> <status>, /gadd <id> <action>, /gdelete <id>',
    '- NEVER say you need permission to write files. Use the structured format or tell the user the right command.',
    '',
    'Auto-learning (invisible to the user):',
    'When you discover a durable fact about the user during conversation, emit it in a <learned> block at the end of your reply.',
    'These are parsed out automatically — the user never sees them.',
    '',
    'What to learn:',
    '- Personal facts: name, location, family, birthday, spoken languages',
    '- Professional context: role, company, industry, team size, revenue stage',
    '- Preferences: communication style, tools they use, work hours, routines',
    '- Business context: current projects, clients, products, pricing, target audience',
    '- Technical preferences: languages, frameworks, conventions',
    '- Goals and aspirations mentioned in passing',
    '',
    'What NOT to learn:',
    '- Anything already in memory.md or user.md (check before emitting)',
    '- Transient info: current mood, one-time requests, what they are doing right now',
    '- Opinions about current events or other people',
    '- Anything the user says is private or off the record',
    '- Vague or uncertain facts',
    '',
    'Format — one block per fact, at the end of your response:',
    '<learned>Prefers morning meetings before 10am</learned>',
    '<learned>Company is Acme Corp, B2B SaaS, 12-person team</learned>',
    '',
    'Frequency: most messages will have zero <learned> blocks. Only emit when confident the fact is durable and new. Maximum 3 per response.',
  ].join('\n');
}

// ─── Conversation formatter ───────────────────────────────────────────────────

/**
 * Formats the conversation history as plain text for stdin.
 * The CLI sees this as one user message containing the full thread;
 * Claude naturally infers the multi-turn structure from the labels.
 */
function formatConversation(history) {
  return history
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
}

// ─── Claude subprocess ────────────────────────────────────────────────────────

/**
 * Calls `claude --print` via subprocess.
 *
 * Two Windows-specific fixes applied here:
 *  1. shell: true  — required on Windows to execute .cmd files (npm global bins)
 *                    without needing the full path.
 *  2. No --system-prompt arg — the memory context is embedded directly in stdin
 *                    inside <memory_context> tags, avoiding all shell-escaping
 *                    issues with markdown content (backticks, quotes, etc.).
 *
 * CLAUDE_CODE is stripped from the child's environment so the CLI does not
 * detect a nested session and refuse to run.
 */
function callClaude(memoryContext, stdinConversation, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {

    // Strip the nested-session guard variables
    const env = { ...process.env };
    delete env.CLAUDE_CODE;
    delete env.CLAUDECODE;

    const args = [
      '--print',
      '--model', CLAUDE_MODEL,
      '--no-session-persistence',
      '--output-format', 'text',
    ];

    console.log('[claude] spawning:', 'claude', args.join(' '));

    const proc = spawn('claude', args, {
      env,
      cwd: ROOT,
      shell: process.platform === 'win32', // .cmd shim needs shell on Windows; Linux runs the binary directly
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    // Timeout guard — kill the process if it takes too long
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        reject(new Error(`claude subprocess timed out after ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);

    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });

    proc.on('close', code => {
      clearTimeout(timer);
      if (settled) return; // already rejected by timeout
      settled = true;
      if (code === 0) {
        console.log('[claude] success, response length:', stdout.length);
        resolve(stdout.trim());
      } else {
        console.error('[claude] failed with code', code, '| stderr:', stderr.trim().slice(0, 200));
        reject(new Error(`claude exited ${code}: ${stderr.trim() || '(no stderr)'}`));
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (err.code === 'ENOENT') {
        reject(new Error('claude CLI not found. Run `claude --version` to verify installation.'));
      } else {
        reject(err);
      }
    });

    // Embed the memory context in stdin using XML tags Claude recognises,
    // then append the conversation. This avoids --system-prompt shell-escaping entirely.
    const stdinText = `<memory_context>\n${memoryContext}\n</memory_context>\n\n${stdinConversation}`;
    console.log('[claude] stdin length:', stdinText.length, 'chars');
    proc.stdin.write(stdinText, 'utf8');
    proc.stdin.end();
  });
}

async function askClaude(chatId, userMessage, { includeSkill = true } = {}) {
  const base = buildMemoryContext({ includeSkill });
  const extra = sessionContexts.get(chatId);
  const memoryContext = extra ? `${base}\n\n---\n\n${extra}` : base;

  if (!histories.has(chatId)) histories.set(chatId, []);
  const history = histories.get(chatId);

  history.push({ role: 'user', content: userMessage });
  while (history.length > MAX_HISTORY) history.shift();

  const stdinConversation = formatConversation(history);
  const rawReply = await callClaude(memoryContext, stdinConversation);

  const { cleaned: afterTools, results: toolResults } = executeToolCalls(rawReply);
  if (toolResults.length > 0) {
    console.log('[tools]', toolResults.join(' | '));
  }

  const { cleaned: reply, learnings } = extractLearnings(afterTools);
  if (learnings.length > 0) {
    const saved = saveLearnings(learnings);
    console.log(`[autolearn] ${learnings.length} found, ${saved} saved`);
  }

  history.push({ role: 'assistant', content: reply });
  while (history.length > MAX_HISTORY) history.shift();

  return reply;
}

// ─── Daily log ────────────────────────────────────────────────────────────────

function appendExchangeToLog(userText, assistantText) {
  const today = todayStr();
  const logPath = join(MEMORY_DIR, `${today}.md`);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });

  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  if (!existsSync(logPath)) writeFileSync(logPath, `# Daily Log — ${today}\n`, 'utf8');

  const entry = `\n## Telegram — ${time}\n\n**You:** ${userText}\n\n**Brain:** ${assistantText}\n`;
  appendFileSync(logPath, entry, 'utf8');
  reindexInBackground();
}

function appendToMemoryMd(text) {
  const memPath = join(ROOT, 'memory.md');
  const today = todayStr();
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });

  if (!existsSync(memPath)) writeFileSync(memPath, `# Memory\n`, 'utf8');

  appendFileSync(memPath, `\n- **${today} ${time}** ${text}\n`, 'utf8');
}

// ─── Tool call executor ───────────────────────────────────────────────────────

/**
 * Parses and executes <tool_call> blocks that Claude emits in its response.
 * Supports: Edit (find/replace) and Write (full overwrite).
 * Returns the response with all <tool_call> blocks stripped out.
 */
// Safe paths for tool call file writes (relative to ROOT)
const BLOCKED_FILES = new Set(['.env', 'bot.mjs', 'package.json', 'package-lock.json']);

function isSafeWritePath(filePath) {
  const resolved = resolve(filePath);
  if (!resolved.startsWith(ROOT)) return false;
  const base = resolved.split(/[\\/]/).pop();
  if (BLOCKED_FILES.has(base)) return false;
  if (base.endsWith('.mjs') || base.endsWith('.js')) return false;
  return true;
}

function executeToolCalls(responseText) {
  const TOOL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const results = [];
  let match;

  while ((match = TOOL_RE.exec(responseText)) !== null) {
    try {
      const { name, arguments: args } = JSON.parse(match[1]);

      if (name === 'Edit') {
        const { file_path, old_string, new_string } = args;
        if (!isSafeWritePath(file_path)) {
          results.push(`Edit blocked — unsafe path: ${file_path}`);
          continue;
        }
        if (!existsSync(file_path)) {
          results.push(`Edit failed — file not found: ${file_path}`);
          continue;
        }
        const content = readFileSync(file_path, 'utf8');
        if (!content.includes(old_string)) {
          results.push(`Edit failed — old_string not found in ${file_path}`);
          continue;
        }
        writeFileSync(file_path, content.replace(old_string, new_string), 'utf8');
        results.push(`Edited ${file_path}`);

      } else if (name === 'Write') {
        const { file_path, content } = args;
        if (!isSafeWritePath(file_path)) {
          results.push(`Write blocked — unsafe path: ${file_path}`);
          continue;
        }
        writeFileSync(file_path, content, 'utf8');
        results.push(`Wrote ${file_path}`);

      } else {
        results.push(`Unknown tool: ${name}`);
      }
    } catch (err) {
      results.push(`Tool parse error: ${err.message}`);
    }
  }

  const cleaned = responseText.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '').trim();
  return { cleaned, results };
}

// ─── Auto-learning: extract <learned> blocks ─────────────────────────────────

function extractLearnings(responseText) {
  const LEARNED_RE = /<learned>\s*([\s\S]*?)\s*<\/learned>/g;
  const learnings = [];
  let match;
  while ((match = LEARNED_RE.exec(responseText)) !== null) {
    const fact = match[1].trim();
    if (fact.length > 0 && fact.length <= 500) learnings.push(fact);
  }
  const cleaned = responseText.replace(/<learned>\s*[\s\S]*?\s*<\/learned>/g, '').trim();
  return { cleaned, learnings: learnings.slice(0, 3) };
}

function isDuplicateLearning(fact) {
  const memPath = join(ROOT, 'memory.md');
  if (!existsSync(memPath)) return false;
  const existing = readFileSync(memPath, 'utf8').toLowerCase();
  const normalized = fact.toLowerCase().trim();
  if (existing.includes(normalized)) return true;
  const factWords = new Set(normalized.split(/\s+/).filter(w => w.length > 3));
  if (factWords.size === 0) return false;
  for (const line of existing.split('\n')) {
    const lineWords = new Set(line.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (lineWords.size === 0) continue;
    let overlap = 0;
    for (const w of factWords) { if (lineWords.has(w)) overlap++; }
    if (overlap / factWords.size >= 0.8) return true;
  }
  return false;
}

function saveLearnings(learnings) {
  let saved = 0;
  for (const fact of learnings) {
    if (isDuplicateLearning(fact)) {
      console.log('[autolearn] skipped duplicate:', fact.slice(0, 60));
      continue;
    }
    appendToMemoryMd(`[auto-learned] ${fact}`);
    console.log('[autolearn] saved:', fact.slice(0, 60));
    saved++;
  }
  if (saved > 0) reindexInBackground();
  return saved;
}

// ─── Goal change parser (structured output from /goals review) ───────────────

/**
 * Parse a GOAL_CHANGES...END_GOAL_CHANGES block from Claude's reply.
 * Returns array of { type, goalTitle, text } or null if no block found.
 *
 * Format:
 *   GOAL_CHANGES
 *   DONE|<goal title>|<action text>
 *   ADD|<goal title>|<new action text>
 *   METRIC|<goal title>|<metric text>
 *   STATUS|<goal title>|<new status>
 *   REVIEWED|<goal title>
 *   END_GOAL_CHANGES
 */
function parseGoalChanges(text) {
  const block = text.match(/GOAL_CHANGES\n([\s\S]*?)\nEND_GOAL_CHANGES/);
  if (!block) return null;

  const lines = block[1].trim().split('\n').filter(l => l.trim());
  const changes = [];

  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 2) continue;

    const type = parts[0].toUpperCase();
    const goalTitle = parts[1];

    if (type === 'DONE' && parts[2]) {
      changes.push({ type: 'done', goalTitle, text: parts[2] });
    } else if (type === 'ADD' && parts[2]) {
      changes.push({ type: 'add', goalTitle, text: parts[2] });
    } else if (type === 'METRIC' && parts[2]) {
      changes.push({ type: 'metric', goalTitle, text: parts[2] });
    } else if (type === 'STATUS' && parts[2]) {
      changes.push({ type: 'status', goalTitle, text: parts[2] });
    } else if (type === 'REVIEWED') {
      changes.push({ type: 'reviewed', goalTitle });
    }
  }

  return changes.length > 0 ? changes : null;
}

/**
 * Apply parsed goal changes to goals.md on disk.
 * Returns a summary string of what was changed.
 */
function applyGoalChanges(changes) {
  const goalsPath = join(ROOT, 'goals.md');
  if (!existsSync(goalsPath)) return 'goals.md not found.';

  let content = readFileSync(goalsPath, 'utf8');
  const today = todayStr();
  const results = [];

  for (const change of changes) {
    const titleEsc = change.goalTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (change.type === 'done') {
      // Check off: - [ ] <text> → - [x] <text>
      const actionEsc = change.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`- \\[ \\]\\s*${actionEsc}`, 'i');
      if (re.test(content)) {
        content = content.replace(re, `- [x] ${change.text}`);
        results.push(`Checked off: ${change.text}`);
      }
    } else if (change.type === 'add') {
      // Append action under **Actions:** for the matching goal
      const re = new RegExp(
        `(## ${titleEsc}[\\s\\S]*?\\*\\*Actions:\\*\\*[\\s\\S]*?)(\\n\\*\\*|\\n---)`,
        'i'
      );
      if (re.test(content)) {
        content = content.replace(re, `$1\n- [ ] ${change.text}$2`);
        results.push(`Added action: ${change.text}`);
      }
    } else if (change.type === 'metric') {
      // Append metric under **Metrics:** for the matching goal
      const re = new RegExp(
        `(## ${titleEsc}[\\s\\S]*?\\*\\*Metrics:\\*\\*[\\s\\S]*?)(\\n\\*\\*|\\n---)`,
        'i'
      );
      if (re.test(content)) {
        content = content.replace(re, `$1\n- [${today}] ${change.text}$2`);
        results.push(`Metric logged: ${change.text}`);
      }
    } else if (change.type === 'status') {
      // Change **Status:** `old` → `new`
      const re = new RegExp(
        `(## ${titleEsc}[\\s\\S]*?\\*\\*Status:\\*\\*\\s*)\`[^\`]*\``,
        'i'
      );
      if (re.test(content)) {
        content = content.replace(re, `$1\`${change.text}\``);
        results.push(`Status → ${change.text}: ${change.goalTitle}`);
      }
    } else if (change.type === 'reviewed') {
      // Update **Last reviewed:** date
      const re = new RegExp(
        `(## ${titleEsc}[\\s\\S]*?\\*\\*Last reviewed:\\*\\*\\s*)\\S+`,
        'i'
      );
      if (re.test(content)) {
        content = content.replace(re, `$1${today}`);
        results.push(`Reviewed: ${change.goalTitle}`);
      }
    }
  }

  if (results.length > 0) {
    writeFileSync(goalsPath, content, 'utf8');
  }

  return results.length > 0 ? results.join('\n') : 'No changes applied.';
}

/**
 * Strip GOAL_CHANGES block from text before sending to user.
 */
function stripGoalChanges(text) {
  return text.replace(/\n?GOAL_CHANGES\n[\s\S]*?\nEND_GOAL_CHANGES\n?/g, '').trim();
}

/**
 * Strip ALL structured output blocks (GOAL_CHANGES, GOAL_PROPOSAL, POST_PROPOSAL)
 * from text before sending to Telegram. Use this on any Claude reply that might
 * contain structured data the user should not see.
 */
function stripStructuredBlocks(text) {
  return text
    .replace(/\n?GOAL_CHANGES\n[\s\S]*?\nEND_GOAL_CHANGES\n?/g, '')
    .replace(/\n?GOAL_PROPOSAL\n[\s\S]*?\nEND_GOAL_PROPOSAL\n?/g, '')
    .replace(/\n?POST_PROPOSAL\n[\s\S]*?\nEND_POST_PROPOSAL\n?/g, '')
    .replace(/<learned>\s*[\s\S]*?\s*<\/learned>/g, '')
    .trim();
}

// ─── Background re-index ──────────────────────────────────────────────────────

function reindexInBackground() {
  execFileAsync('node', ['memory_manager.mjs', 'index'], { cwd: ROOT })
    .then(({ stdout }) => {
      const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
      if (clean && !clean.includes('0 updated, 0 unchanged')) {
        console.log('[index]', clean.split('\n').pop());
      }
    })
    .catch(err => console.error('[index error]', err.message));
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

function splitMessage(text) {
  if (text.length <= TG_LIMIT) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > TG_LIMIT) {
    let cut = remaining.lastIndexOf('\n\n', TG_LIMIT);
    if (cut < TG_LIMIT / 2) cut = remaining.lastIndexOf('\n', TG_LIMIT);
    if (cut <= 0) cut = TG_LIMIT;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

async function send(chatId, text, extra = {}) {
  for (const part of splitMessage(text)) {
    await bot.sendMessage(chatId, part, { parse_mode: 'Markdown', ...extra })
      .catch(() => bot.sendMessage(chatId, part, extra));
  }
}

// ─── Authorization ────────────────────────────────────────────────────────────

function authorized(userId) {
  const allowed = process.env.ALLOWED_TELEGRAM_USER_ID || ALLOWED_TELEGRAM_USER_ID;
  if (!allowed) return true;
  return String(userId) === String(allowed);
}

// ─── Web search ───────────────────────────────────────────────────────────────

/**
 * Phrases that signal the user wants a web search.
 * Captures everything after the trigger phrase as the query.
 */
const WEB_SEARCH_RE = /^(?:look\s+up|search\s+for|find\s+out(?:\s+about)?|research|busca(?:r)?|investiga(?:r)?)\s+(.+)/is;

/** Extract web search query from a plain message, or return null. */
function detectWebSearch(text) {
  const m = text.match(WEB_SEARCH_RE);
  return m ? m[1].trim() : null;
}

/**
 * Run a DuckDuckGo search, have Claude summarize the results, reply to the chat.
 * Reuses the existing callClaude subprocess with an empty memory context so the
 * response is focused entirely on the search results.
 */
async function handleWebSearch(chatId, query) {
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  let results;
  try {
    results = await searchDuckDuckGo(query, 5);
  } catch (err) {
    await send(chatId, `Web search error: ${err.message}`);
    return null;
  }

  if (results.length === 0) {
    await send(chatId, `No results found for: _${query}_`);
    return null;
  }

  const numbered = results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n');

  const prompt = [
    `User query: "${query}"`,
    '',
    'Web search results (DuckDuckGo):',
    '',
    numbered,
    '',
    'Summarize these results to answer the query. 3-5 sentences, specific and direct.',
    'Include numbered source links at the end. Format for Telegram (*bold*, _italic_, `code`).',
    'Do not start with filler like "Based on the search results...".',
  ].join('\n');

  let reply;
  try {
    reply = await callClaude('', prompt);
  } catch (err) {
    await send(chatId, `Summarization error: ${err.message}`);
    return null;
  }

  const { cleaned } = executeToolCalls(reply);
  await send(chatId, cleaned);
  return { query, reply: cleaned };
}

// ─── Document creation ────────────────────────────────────────────────────────

/**
 * Phrases that signal the user wants a document created.
 * Captures the topic as the last group.
 */
const DOC_RE = /^(?:create\s+(?:a\s+)?doc(?:ument)?(?:\s+(?:about|on))?|write\s+(?:a\s+)?(?:note|doc|document)(?:\s+(?:on|about))?|crea(?:r)?\s+(?:un[ao]?\s+)?(?:doc(?:umento)?|nota)(?:\s+(?:sobre|de|acerca\s+de))?)\s+(.+)/is;

/** Extract document topic from a plain message, or return null. */
function detectDocRequest(text) {
  const m = text.match(DOC_RE);
  return m ? m[1].trim() : null;
}

/** Turn a topic string into a safe filename slug. */
function topicToSlug(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

/**
 * Ask Claude to write a Markdown document on the given topic,
 * save it to documents/<date>-<slug>.md, and reply with path + preview.
 */
async function handleDocCreation(chatId, topic) {
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  const memoryContext = buildMemoryContext();

  const prompt = [
    `Write a well-structured Markdown document for the user's second brain.`,
    ``,
    `Topic: ${topic}`,
    ``,
    `Requirements:`,
    `- Start with a single H1 title (# Title)`,
    `- Follow with a short 2-3 sentence summary`,
    `- Use H2 sections (## Section) to organize the content`,
    `- Use bullet points, numbered lists, or code blocks where they add clarity`,
    `- Keep it practical and actionable — tailor to the user's context from user.md`,
    `- Tailor depth to the topic: a quick note can be short; a framework doc can be longer`,
    ``,
    `Output ONLY the raw Markdown content. No commentary before or after.`,
  ].join('\n');

  let content;
  try {
    content = await callClaude(memoryContext, prompt);
  } catch (err) {
    await send(chatId, `Document error: ${err.message}`);
    return null;
  }

  // Strip any <tool_call> blocks Claude might emit
  ({ cleaned: content } = executeToolCalls(content));

  // Build filename and ensure directory exists
  const date = todayStr();
  const slug = topicToSlug(topic);
  const filename = `${date}-${slug}.md`;
  const filePath = join(DOCS_DIR, filename);
  const relPath = `documents/${filename}`;

  try {
    if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    await send(chatId, `Could not save document: ${err.message}`);
    return null;
  }

  // Re-index so the new doc is searchable
  reindexInBackground();

  // Upload to Google Drive
  const driveLink = await uploadToDrive(filename, content);

  // Build preview: first 4 non-empty lines (title + opening sentences)
  const previewLines = content
    .split('\n')
    .filter(l => l.trim())
    .slice(0, 4)
    .join('\n');

  let msg = `*Document saved:* \`${relPath}\`\n\n` +
    `*Preview:*\n\`\`\`\n${previewLines}\n\`\`\``;
  if (driveLink) msg += `\n\n*Google Drive:* ${driveLink}`;
  await send(chatId, msg);

  return { topic, filePath: relPath, content };
}

// ─── Slides ──────────────────────────────────────────────────────────────────

async function handleSlidesCreation(chatId, topic) {
  if (!isGoogleAuthorised()) {
    await send(chatId, 'Google not connected. Use /gauth first.');
    return null;
  }

  await send(chatId, 'Generating presentation...');
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  const memoryContext = buildMemoryContext();

  const prompt = [
    `Generate a presentation about: ${topic}`,
    '',
    'Return ONLY a JSON array. No markdown fences, no commentary.',
    'Each element: { "title": "slide title", "bullets": ["point 1", "point 2", "point 3"] }',
    'First element is the cover slide (title of the presentation, bullets can be empty or a subtitle).',
    '5-8 slides total. Keep bullet points concise (max 12 words each). 3-5 bullets per slide.',
    'Write in Spanish unless the topic is explicitly in English.',
  ].join('\n');

  let raw;
  try {
    raw = await callClaude(memoryContext, prompt);
  } catch (err) {
    await send(chatId, `Slides error: ${err.message}`);
    return null;
  }

  // Strip markdown fences if Claude wrapped the JSON
  raw = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

  let slides;
  try {
    slides = JSON.parse(raw);
    if (!Array.isArray(slides) || slides.length === 0) throw new Error('Empty slides array');
  } catch (err) {
    await send(chatId, `Could not parse slide content: ${err.message}\n\nClaude returned:\n\`\`\`\n${raw.slice(0, 500)}\n\`\`\``);
    return null;
  }

  // Create the presentation
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  let result;
  try {
    const title = slides[0]?.title || topic;
    result = await createPresentation(title, slides);
  } catch (err) {
    await send(chatId, `Google Slides error: ${err.message}`);
    return null;
  }

  const slideCount = slides.length;
  let msg = `*Presentation created:* ${slideCount} slides\n\n`;
  msg += `*Title:* ${slides[0]?.title || topic}\n`;
  msg += `*Google Slides:* ${result.url}`;
  await send(chatId, msg);

  return { topic, url: result.url, slideCount };
}

// ─── Freedcamp ────────────────────────────────────────────────────────────────

/**
 * Words that suggest the user is asking about tasks/projects.
 * When detected, Freedcamp data is automatically injected as context.
 */
const FREEDCAMP_RE = /\b(task|tasks|tarea|tareas|project|projects|proyecto|proyectos|freedcamp|milestone|deadline|pendiente|pending|backlog|sprint|assigned|assignee|asignado|priority|prioridad)\b/i;

function detectFreedcampQuery(text) {
  return FREEDCAMP_RE.test(text);
}

/**
 * Fetch Freedcamp data and have Claude analyze it in the context of the question.
 */
async function handleFreedcampQuery(chatId, userMessage) {
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  let fcContext;
  try {
    fcContext = await getFreedcampContext();
  } catch (err) {
    await send(chatId, `Freedcamp error: ${err.message}`);
    return null;
  }

  const memoryContext = buildMemoryContext();

  if (!histories.has(chatId)) histories.set(chatId, []);
  const history = histories.get(chatId);

  history.push({ role: 'user', content: userMessage });
  while (history.length > MAX_HISTORY) history.shift();

  // Inject Freedcamp data between memory context and conversation
  const stdinConversation = formatConversation(history);
  const fullContext = [
    memoryContext,
    '',
    '---',
    '',
    fcContext,
  ].join('\n');

  let rawReply;
  try {
    rawReply = await callClaude(fullContext, stdinConversation);
  } catch (err) {
    await send(chatId, `Error: ${err.message}`);
    return null;
  }

  const { cleaned: reply } = executeToolCalls(rawReply);

  history.push({ role: 'assistant', content: reply });
  while (history.length > MAX_HISTORY) history.shift();

  await send(chatId, stripStructuredBlocks(reply));
  return reply;
}

// ─── Goal wizard helpers ──────────────────────────────────────────────────────

/** Extracts a GOAL_PROPOSAL...END_GOAL_PROPOSAL block from Claude's response. */
function parseGoalProposal(text) {
  const block = text.match(/GOAL_PROPOSAL\n([\s\S]*?)\nEND_GOAL_PROPOSAL/);
  if (!block) return null;

  const content = block[1];
  const title     = content.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const why       = content.match(/^why:\s*(.+)$/m)?.[1]?.trim();
  const metrics   = content.match(/^metrics:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const timeframe = content.match(/^timeframe:\s*(.+)$/m)?.[1]?.trim() ?? '';

  const actionsBlock = content.match(/^actions:\n([\s\S]*)/m)?.[1] ?? '';
  const actions = actionsBlock.split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);

  if (!title || actions.length === 0) return null;
  return { title, why, metrics, timeframe, actions };
}

/** Formats a parsed proposal for Telegram display. */
function formatProposalForTelegram(p) {
  const metricLines = p.metrics
    ? p.metrics.split('|').map(m => `• ${m.trim()}`).join('\n')
    : '(none specified)';
  const actionLines = p.actions.map((a, i) => `${i + 1}. ${a}`).join('\n');

  return [
    `*Goal:* ${p.title}`,
    ``,
    `*Why it matters:*`,
    `_${p.why}_`,
    ``,
    `*Metrics:*`,
    metricLines,
    ``,
    `*Timeframe:* ${p.timeframe}`,
    ``,
    `*Actions (${p.actions.length}):*`,
    actionLines,
  ].join('\n');
}

/** Appends a new goal section to goals.md. */
function writeGoalToGoalsMd(p) {
  const today   = todayStr();
  const metrics = p.metrics
    ? p.metrics.split('|').map(m => `- ${m.trim()}: ?`).join('\n')
    : '- (add metrics)';
  const actions = p.actions.map(a => `- [ ] ${a}`).join('\n');

  const section = [
    `## ${p.title}`,
    ``,
    `**Status:** \`active\``,
    `**Category:** business`,
    `**Created:** ${today}`,
    `**Last reviewed:** ${today}`,
    ``,
    `**Why this matters:**`,
    p.why,
    ``,
    `**Metrics:**`,
    metrics,
    ``,
    `**Actions:**`,
    ``,
    actions,
    ``,
    `**Balance check:**`,
    `Review weekly. If no movement for 2 weeks, revisit the approach.`,
    ``,
    `---`,
    ``,
  ].join('\n');

  const goalsPath = join(ROOT, 'goals.md');
  const existing  = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf8') : '# Goals\n\n---\n\n';
  writeFileSync(goalsPath, existing + section, 'utf8');
}

// ─── LinkedIn wizard helpers ───────────────────────────────────────────────────

/** Extracts a POST_PROPOSAL...END_POST_PROPOSAL block from Claude's response. */
function parsePostProposal(text) {
  const block = text.match(/POST_PROPOSAL\n([\s\S]*?)\nEND_POST_PROPOSAL/);
  if (!block) return null;

  const content  = block[1];
  const hook     = content.match(/^hook:\s*(.+)$/m)?.[1]?.trim();
  const body     = content.match(/^body:\s*(.+)$/m)?.[1]?.trim()?.replace(/\\n/g, '\n');
  const cta      = content.match(/^cta:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const hashtags = content.match(/^hashtags:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const angle    = content.match(/^angle:\s*(.+)$/m)?.[1]?.trim() ?? '';

  if (!hook || !body) return null;
  return { hook, body, cta, hashtags, angle };
}

/** Formats a parsed LinkedIn post preview for Telegram. */
function formatPostForTelegram(p) {
  const tags = p.hashtags.split(/\s+/).filter(Boolean).map(t => `#${t.replace(/^#/, '')}`).join(' ');
  const fullPost = [p.hook, '', p.body, '', p.cta].filter(Boolean).join('\n');

  return [
    `*LinkedIn Post Preview*`,
    ``,
    `*Angle:* _${p.angle}_`,
    ``,
    `─────────────────────`,
    ``,
    fullPost,
    ``,
    tags,
    ``,
    `─────────────────────`,
    ``,
    `${fullPost.split(/\s+/).length} words`,
  ].join('\n');
}

/** Appends a LinkedIn post to documents/linkedin-posts.md. */
function writePostToFile(p) {
  const today    = todayStr();
  const tags     = p.hashtags.split(/\s+/).filter(Boolean).map(t => `#${t.replace(/^#/, '')}`).join(' ');
  const fullPost = [p.hook, '', p.body, '', p.cta].filter(Boolean).join('\n');

  const section = [
    `## ${today}`,
    ``,
    `> **Angle:** ${p.angle}`,
    ``,
    fullPost,
    ``,
    tags,
    ``,
    `---`,
    ``,
  ].join('\n');

  const docDir  = join(ROOT, 'documents');
  const docPath = join(docDir, 'linkedin-posts.md');
  if (!existsSync(docDir)) mkdirSync(docDir, { recursive: true });
  const existing = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '# LinkedIn Posts\n\n';
  writeFileSync(docPath, existing + section, 'utf8');
}

/** Start the LinkedIn content wizard for a chat. */
async function startLinkedinWizard(chatId) {
  const skill = readSafe(join(ROOT, '.claude', 'skills', 'linkedin', 'SKILL.md'));
  if (!skill) {
    await send(chatId, 'LinkedIn skill file not found.');
    return;
  }

  linkedinWizardState.set(chatId, 'active');
  histories.delete(chatId);
  sessionContexts.set(chatId, `# LinkedIn Content Expert — follow these steps exactly\n\n${skill}`);

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  const reply = await askClaude(chatId, 'Start the LinkedIn post creation session. Ask the first question now.');
  const proposal = parsePostProposal(reply);
  if (proposal) {
    pendingLinkedinPosts.set(chatId, proposal);
    await send(chatId, formatPostForTelegram(proposal));
    await send(chatId, 'Say *postit* (or /postit) to save this post, or describe any changes you want.');
  } else {
    await send(chatId, stripStructuredBlocks(reply));
  }
  appendExchangeToLog('/linkedin', stripStructuredBlocks(reply));
}

/** Save confirmed LinkedIn post to documents/linkedin-posts.md. */
async function confirmLinkedinPost(chatId) {
  const post = pendingLinkedinPosts.get(chatId);
  if (!post) {
    await send(chatId, 'No pending LinkedIn post. Say "write a LinkedIn post" to start.');
    return;
  }

  try {
    writePostToFile(post);
  } catch (err) {
    await send(chatId, `Could not save post: ${err.message}`);
    return;
  }

  linkedinWizardState.delete(chatId);
  pendingLinkedinPosts.delete(chatId);
  sessionContexts.delete(chatId);
  histories.delete(chatId);

  // Upload post to Google Drive
  const fullPost = [post.hook, '', post.body, '', post.cta].filter(Boolean).join('\n');
  const driveLink = await uploadToDrive(`LinkedIn Post — ${todayStr()}`, fullPost);

  let msg = `*Post saved* to documents/linkedin-posts.md\n\n` +
    `Copy the post above and paste it directly into LinkedIn.`;
  if (driveLink) msg += `\n\n*Google Drive:* ${driveLink}`;
  await send(chatId, msg);
  appendExchangeToLog('/postit', `LinkedIn post saved.`);
}

// ─── Super Team expert session helpers ────────────────────────────────────────

const EXPERT_NAMES = {
  hormozi: 'Alex Hormozi (Offer Architect)',
  ogilvy: 'David Ogilvy (Copy Chief)',
  garyvee: 'Gary Vee (Content Strategist)',
  brunson: 'Russell Brunson (Funnel Architect)',
  suby: 'Sabri Suby (Lead Gen Strategist)',
};

/** Parse SESSION_SUMMARY block from Claude's reply. */
function parseSessionSummary(text) {
  const block = text.match(/SESSION_SUMMARY\n([\s\S]*?)\nEND_SESSION_SUMMARY/);
  if (!block) return null;

  const content = block[1];
  const expert = content.match(/^expert:\s*(.+)$/m)?.[1]?.trim();
  const title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const body = content.match(/^content:\n([\s\S]*)/m)?.[1]?.trim();

  if (!expert || !title || !body) return null;
  return { expert, title, body };
}

/** Strip SESSION_SUMMARY block from text before sending to user. */
function stripSessionSummary(text) {
  return text.replace(/\n?SESSION_SUMMARY\n[\s\S]*?\nEND_SESSION_SUMMARY\n?/g, '').trim();
}

/** Save a session summary document to documents/ and upload to Google Drive. */
async function saveExpertDocument(chatId, summary) {
  const today = todayStr();
  const slug = summary.expert.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const fileName = `expert-${slug}-${today}.md`;
  const filePath = join(ROOT, 'documents', fileName);

  const doc = [
    `# ${EXPERT_NAMES[summary.expert] || summary.expert} — Session Summary`,
    ``,
    `**Date:** ${today}`,
    `**Topic:** ${summary.title}`,
    ``,
    `---`,
    ``,
    summary.body,
  ].join('\n');

  writeFileSync(filePath, doc, 'utf8');

  const driveLink = await uploadToDrive(fileName, doc);
  let msg = `Session saved to \`${filePath}\``;
  if (driveLink) msg += `\n\n*Google Drive:* ${driveLink}`;
  await send(chatId, msg);

  return filePath;
}

/** Start a super-team expert session. */
async function startExpertSession(chatId, expertHint) {
  const skill = readSafe(join(ROOT, '.claude', 'skills', 'super-team', 'SKILL.md'));
  if (!skill) {
    await send(chatId, 'Super Team skill file not found.');
    return;
  }

  expertSessionState.set(chatId, true);
  goalWizardState.delete(chatId);
  goalReviewState.delete(chatId);
  linkedinWizardState.delete(chatId);
  histories.delete(chatId);
  sessionContexts.set(chatId, `# Super Team Expert Session — follow the skill instructions exactly\n\n${skill}`);

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const prompt = expertHint
      ? `The user wants help with: "${expertHint}". Auto-detect the right expert and begin the session. Jump straight into character and ask the first question.`
      : 'Present the expert menu and ask the user to pick one.';
    const reply = await askClaude(chatId, prompt);

    const summary = parseSessionSummary(reply);
    if (summary) {
      await send(chatId, stripSessionSummary(stripStructuredBlocks(reply)));
      await saveExpertDocument(chatId, summary);
      expertSessionState.delete(chatId);
      sessionContexts.delete(chatId);
      reindexInBackground();
    } else {
      await send(chatId, stripStructuredBlocks(reply));
    }
    appendExchangeToLog(expertHint || '/expert', stripStructuredBlocks(stripSessionSummary(reply)));
  } catch (err) {
    console.error('[expert] ERROR:', err.message);
    expertSessionState.delete(chatId);
    sessionContexts.delete(chatId);
    await send(chatId, `Expert session error: ${err.message}`).catch(() => { });
  }
}

// ─── Goal wizard helpers ──────────────────────────────────────────────────────

/** Shared: start the goal wizard for a chat. */
async function startGoalWizard(chatId) {
  const skill = readSafe(join(ROOT, '.claude', 'skills', 'new-goal', 'SKILL.md'));
  if (!skill) {
    await send(chatId, 'Goal wizard skill file not found.');
    return;
  }

  goalWizardState.set(chatId, 'active');
  goalReviewState.delete(chatId);   // Clear review state if entering wizard mid-review
  histories.delete(chatId);
  sessionContexts.set(chatId, `# New Goal Wizard — follow these steps exactly\n\n${skill}`);

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const reply = await askClaude(chatId, 'Begin the goal creation session.');
    const proposal = parseGoalProposal(reply);
    if (proposal) {
      pendingGoalProposals.set(chatId, proposal);
      await send(chatId, formatProposalForTelegram(proposal));
      await send(chatId, 'Say *confirm* (or /confirm) to save + push to Todoist, or describe any changes.');
    } else {
      await send(chatId, stripStructuredBlocks(reply));
    }
    appendExchangeToLog('/newgoal', stripStructuredBlocks(reply));
  } catch (err) {
    console.error('[newgoal] ERROR:', err.message);
    goalWizardState.delete(chatId);
    sessionContexts.delete(chatId);
    await send(chatId, `Goal wizard error: ${err.message}`).catch(() => { });
  }
}

/** Shared: save confirmed proposal to goals.md + Todoist. */
async function confirmGoal(chatId) {
  const proposal = pendingGoalProposals.get(chatId);
  if (!proposal) {
    await send(chatId, 'No pending goal proposal. Say "set a new goal" to start.');
    return;
  }

  await send(chatId, 'Saving goal and pushing to Todoist...');
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  try {
    writeGoalToGoalsMd(proposal);
  } catch (err) {
    await send(chatId, `Could not write to goals.md: ${err.message}`);
    return;
  }

  try {
    await execFileAsync('node', ['goals_manager.mjs', 'index'], { cwd: ROOT });
  } catch (err) {
    await send(chatId, `Index error: ${err.message}`);
    return;
  }

  let syncOut = '';
  try {
    const { stdout, stderr } = await execFileAsync(
      'node', ['scripts/sync-goals-todoist.mjs'],
      { cwd: ROOT }
    );
    syncOut = (stdout + stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
  } catch (err) {
    await send(chatId, `Todoist sync error: ${err.message}`);
    return;
  }

  // Parse "Created: N" from sync output
  const created = syncOut.match(/Created:\s*(\d+)/)?.[1] ?? '?';

  goalWizardState.delete(chatId);
  goalReviewState.delete(chatId);    // Clear review state too
  pendingGoalProposals.delete(chatId);
  sessionContexts.delete(chatId);
  histories.delete(chatId);

  await send(chatId,
    `*Goal saved.* ${created} action(s) pushed to Todoist.\n\n` +
    `Use /ttasks to see them or /gstatus for an overview.`
  );
  appendExchangeToLog('/confirm', `Goal "${proposal.title}" saved. ${created} tasks pushed.`);
}

// ─── Natural language intent patterns ────────────────────────────────────────

const NL_CONFIRM_RE    = /^(yes|confirm|save|save it|looks good|perfect|go ahead|do it|dale|s[ií]|ok|okay|approve|let'?s? (do it|go)|yep|yup|correct|that'?s right|sounds good|great|confirmed|confirmed!)\b/i;
const NL_GDELETE_RE    = /\b(delete goal|remove goal|borrar objetivo|eliminar objetivo)\s+#?(\d+)\b/i;
const NL_NEW_GOAL_RE   = /\b(set a (new )?goal|create a (new )?goal|new goal|add (a )?goal|i (want|need) (to )?(reach|achieve|accomplish|hit|have) (a )?(new )?goal|my goal is|i have a goal|want a goal|need a goal|goal (of|to) \w|quiero (crear|establecer|lograr|alcanzar|tener) (un )?(nuevo )?objetivo|establecer (un )?objetivo|crear (un )?objetivo|mi objetivo es|tengo (un )?objetivo|agregar (un )?(nuevo )?objetivo|nuevo objetivo)\b/i;
const NL_TSYNC_RE      = /\b(sync (to )?todoist|push (goals?|tasks?) to todoist|push (my )?goals|sincronizar (con )?todoist|subir (a|mis .+ a) todoist)\b/i;
const NL_TPULL_RE      = /\b(pull (from )?todoist|fetch completed|mark completed (from|in) todoist|sync (back|completed) from todoist|traer (completados? )?de todoist)\b/i;
const NL_TTASKS_RE     = /\b(show (my )?todoist|todoist tasks|what'?s? in todoist|ver todoist|mis tareas (en )?todoist|show tasks in todoist)\b/i;
const NL_TCLOSE_RE     = /\b(?:close|complete|finish|done|mark done|cerrar|completar|terminar)\s+(?:all\s+)?(?:(?:freedcamp|fc|todoist)\s+)?(?:tasks?|tareas?)\s+(?:for|in|from|of|de|en|para)\s+(.+)/i;
const NL_GSTATUS_RE    = /\b(goal status|show (my )?goals|how are my goals|ver (mis )?objetivos|estado de (mis )?objetivos|list goals|my goals)\b/i;
const NL_GDIAGRAM_RE   = /\b(goal diagram|goals diagram|show (the )?diagram|generate (the )?diagram|ver diagrama|diagrama de objetivos)\b/i;
const NL_GMAIL_RE      = /\b(show (my )?(unread )?emails?|check (my )?email|unread emails?|mis correos?|ver correos?|bandeja de entrada)\b/i;
const NL_GSEARCH_RE    = /\b(search (my )?(email|gmail|correo)|find (an? )?email|buscar (en )?(correo|gmail))\b/i;
const NL_GMAIL_FROM_RE = /\b(emails?\s+from|received.*email.*from|got.*email.*from|any.*email.*from|correos?\s+de|recib[íi].*de)\s+(\S+)/i;

const NL_DRIVE_RE      = /\b(show (my )?(recent |drive )?files?|recent (drive )?files?|my drive|ver (mis )?archivos|drive files?)\b/i;
const NL_DRSEARCH_RE   = /\b(search (my )?drive|find (a |the )?file( in drive)?|buscar (en )?drive|buscar archivo)\b/i;
const NL_LINKEDIN_RE   = /\b(write (a |my )?linkedin|create (a |my )?linkedin|linkedin post|post (for|on) linkedin|contenido (para|de) linkedin|publicar en linkedin|redactar.*linkedin|generate.*linkedin)\b/i;
const NL_POSTIT_RE     = /^(post it|postit|save (the )?post|publish|publish it|looks good|perfect|dale|s[ií]|yes|confirm)\b/i;
const NL_CALENDAR_RE       = /\b(show (my )?calendar|what'?s? on my calendar|upcoming events?|my schedule|what do I have today|my events?|eventos?|mi calendario|mi agenda|que tengo hoy)\b/i;
const NL_CALENDAR_CREATE_RE = /\b(schedule (a |an )?|create (a |an )?event|add .*to .*calendar|book (a |an )?|send (a |an )?(calendar )?(invitation|invite)|calendar invite|invite .+ to (a |an )?(meeting|event|call)|agendar|crear (un )?evento|enviar (una )?invitaci[oó]n)\b/i;
const NL_MORNING_RE    = /\b(plan (my|the) day|morning (briefing|plan)|start my (day|morning)|planificar (mi )?d[ií]a|briefing matutino)\b/i;
const NL_SLIDES_RE     = /\b(create (a |the )?presentation|make (a |the )?(presentation|slides|slide deck)|genera(r)? (una )?presentaci[oó]n|crear (una )?presentaci[oó]n|crear slides|hazme (una )?presentaci[oó]n)\b/i;

// Super Team expert triggers
const NL_EXPERT_RE     = /\b(super team|expert team|ai team|el equipo|los expertos|marketing equipo|preguntar.*5 expertos|run (the |all )?(5 |five )?experts|ask all 5|advisory board|junta directiva)\b/i;
const NL_HORMOZI_RE    = /\b(audit (my |the )?offer|value equation|grand slam offer|hormozi|fix my (offer|pricing)|improve my offer|my offer (sucks|isn't working)|analizar (mi )?oferta)\b/i;
const NL_OGILVY_RE     = /\b(audit (my |the )?copy|review (my |the )?(copy|headline|ad|landing page|sales page)|ogilvy|tear( apart)? my (copy|ad|headline)|improve my (copy|headlines?|ads?)|mejorar (mi )?copy)\b/i;
const NL_GARYVEE_RE    = /\b(content strate|content plan|content system|social media (plan|strategy)|gary ?v|pillar.?to.?micro|jab jab|content calendar|estrategia de contenido)\b/i;
const NL_BRUNSON_RE    = /\b(build (my |a )?funnel|funnel (help|architect|strategy)|value ladder|perfect webinar|brunson|click ?funnels?|sales funnel|crear (mi )?funnel|embudo)\b/i;
const NL_SUBY_RE       = /\b(lead gen|get (more |me )?leads|sales system|godfather offer|sabri|sell like crazy|8.?phase|sistema de ventas|conseguir (m[aá]s )?leads|generar leads)\b/i;

// ─── Morning briefing helper ─────────────────────────────────────────────────

async function startMorningBriefing(chatId) {
  const skill = readSafe(join(ROOT, '.claude', 'skills', 'morning', 'SKILL.md'));
  if (!skill) { await send(chatId, 'Morning skill file not found.'); return; }

  await send(chatId, 'Gathering your data...');
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  const t0 = Date.now();
  // Fetch all data sources in parallel (direct function calls, no subprocesses)
  const [freedcampResult, todoistResult, calendarResult, goalsResult, gmailResult] = await Promise.allSettled([
    // Freedcamp tasks
    execFileAsync('node', ['scripts/fetch-freedcamp.mjs'], { cwd: ROOT })
      .then(({ stdout, stderr }) =>
        (stdout + stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim()
      ),
    // Todoist tasks — next 3 days only for morning briefing
    getTodoistContext(3),
    // Google Calendar (today's events)
    (isGoogleAuthorised()
      ? getTodayEvents().then(events => {
          if (events.length === 0) return 'No events today.';
          return events.map((e, i) =>
            `${i + 1}. ${e.title} — ${e.start}${e.location ? ' @ ' + e.location : ''}`
          ).join('\n');
        })
      : Promise.resolve('Google not authorised — no calendar data.')
    ),
    // Goals summary
    execFileAsync('node', ['goals_manager.mjs', 'list', '--status=active'], { cwd: ROOT })
      .then(({ stdout, stderr }) =>
        (stdout + stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim()
      ).catch(() => ''),
    // Gmail unread emails
    (isGoogleAuthorised()
      ? getEmailContext(5)
      : Promise.resolve('Google not authorised — no email data.')
    ),
  ]);

  const freedcamp = freedcampResult.status === 'fulfilled' ? freedcampResult.value : `Freedcamp unavailable: ${freedcampResult.reason?.message || 'unknown error'}`;
  const todoist   = todoistResult.status === 'fulfilled' ? todoistResult.value : `Todoist unavailable: ${todoistResult.reason?.message || 'unknown error'}`;
  const calendar  = calendarResult.status === 'fulfilled' ? calendarResult.value : `Calendar unavailable: ${calendarResult.reason?.message || 'unknown error'}`;
  const goals     = goalsResult.status === 'fulfilled' ? goalsResult.value : `Goals unavailable: ${goalsResult.reason?.message || 'unknown error'}`;
  const gmail     = gmailResult.status === 'fulfilled' ? gmailResult.value : `Gmail unavailable: ${gmailResult.reason?.message || 'unknown error'}`;

  const t1 = Date.now();
  console.log('[morning] Data fetch took %dms — FC:%s TD:%s CAL:%s GOALS:%s GMAIL:%s',
    t1 - t0, freedcampResult.status, todoistResult.status, calendarResult.status,
    goalsResult.status, gmailResult.status);
  if (todoistResult.status === 'rejected') console.log('[morning] Todoist error:', todoistResult.reason);
  else console.log('[morning] Todoist content (%d chars): %s', todoist.length, todoist.slice(0, 200));

  // Inject everything into session context
  histories.delete(chatId);
  sessionContexts.set(chatId, [
    '# Morning Briefing — follow these steps',
    '',
    skill,
    '',
    '# Current Freedcamp Tasks',
    '',
    freedcamp,
    '',
    '# Todoist Tasks (open)',
    '',
    todoist || '(none)',
    '',
    '# Calendar — Today',
    '',
    calendar,
    '',
    '# Active Goals',
    '',
    goals || '(none)',
    '',
    '# Gmail — Unread Emails',
    '',
    gmail,
  ].join('\n'));

  const t2 = Date.now();
  const reply = await askClaude(chatId,
    'Start the morning briefing. You have all the data above: Freedcamp tasks, Todoist tasks, ' +
    'today\'s calendar, active goals, and unread emails. First give me a quick overview of what\'s on my plate ' +
    '(key tasks, meetings, goal progress, important emails), then ask what\'s on my mind today.',
    { includeSkill: false }
  );
  console.log('[morning] Claude call took %dms, total %dms', Date.now() - t2, Date.now() - t0);
  await send(chatId, stripStructuredBlocks(reply));
  appendExchangeToLog('/morning', stripStructuredBlocks(reply));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.onText(/^\/start(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;

  const today = todayStr();
  const files = [
    ['soul.md', join(ROOT, 'soul.md')],
    ['user.md', join(ROOT, 'user.md')],
    ['memory.md', join(ROOT, 'memory.md')],
    [`memory/${today}.md`, join(MEMORY_DIR, `${today}.md`)],
  ];
  const status = files
    .map(([name, p]) => `${existsSync(p) ? '✓' : '✗'} \`${name}\``)
    .join('\n');

  await send(msg.chat.id,
    `*Second brain online.* Model: \`${CLAUDE_MODEL}\`\n\n` +
    `*Memory files:*\n${status}\n\n` +
    `Every exchange is logged to \`memory/${today}.md\` automatically.\n\n` +
    `*Commands:*\n` +
    `/clear — reset conversation history\n` +
    `/status — show memory file status\n` +
    `/search <query> — web search (DuckDuckGo) + Claude summary\n` +
    `/memory <query> — search memory index (FTS)\n` +
    `/remember <text> — save a fact to memory.md\n` +
    `/doc <topic> — create a Markdown doc in documents/\n` +
    `/fc — show Freedcamp projects + open tasks\n` +
    `/fc <question> — ask Claude about your tasks\n` +
    `/newgoal — create a new goal with AI-guided questions + action plan\n` +
    `/confirm — save the proposed goal + push actions to Todoist\n` +
    `/goals — start an interactive goal review session\n` +
    `/gstatus — quick summary of goal states (shows IDs)\n` +
    `/gdelete <id> — permanently delete a goal from goals.md\n` +
    `/gupdate <id> <status> — change goal status (active/paused/completed/archived)\n` +
    `/gmetric <id> <text> — log a metric update\n` +
    `/gadd <id> <action> — add a new action to a goal\n` +
    `/goals_diagram — generate + receive the goals Excalidraw diagram\n` +
    `/tsync — push pending goal actions to Todoist\n` +
    `/ttasks — show open Todoist tasks\n` +
    `/tpull — pull completed Todoist tasks → mark [x] in goals.md\n` +
    `/tclear <n> — delete all Todoist tasks for goal #n (goals.md unchanged)\n` +
    `/gauth — connect Google account (Gmail + Drive)\n` +
    `/gmail — show unread emails\n` +
    `/gsearch <query> — search Gmail\n` +
    `/gread <id> — read a full email\n` +
    `/gsummarise <id> — AI summary of an email\n` +
    `/gsend <to> | <subject> | <body> — send email\n` +
    `/greply <id> | <body> — reply to email\n` +
    `/drive — list recent Drive files\n` +
    `/drsearch <query> — search Drive\n` +
    `/drread <id> — read a Drive file\n` +
    `/drcreate <title> | <content> — create a Google Doc\n` +
    `/drupdate <id> | <content> — replace a Google Doc's content\n` +
    `/gcal — show upcoming calendar events\n` +
    `/gcaltoday — show today's events\n` +
    `/gcalsearch <query> — search calendar events\n` +
    `/gcalevent <id> — show full event details\n` +
    `/gccreate <title> | <start> | <end> [| desc] [| loc] — create event\n` +
    `/gcdelete <id> — delete an event\n\n` +
    `_Tips:_\n` +
    `_"look up X" / "research X" → web search_\n` +
    `_"create a doc about X" / "write a note on X" → new document_\n` +
    `_Mentioning "tasks", "project", "deadline" → Freedcamp data auto-injected_\n` +
    `_"check my email" / "show unread" → Gmail_\n` +
    `_"show my calendar" / "what do I have today" → Calendar_\n` +
    `_"schedule a meeting tomorrow at 3pm" → create event_`
  );
});

bot.onText(/^\/help(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  await send(msg.chat.id,
    `*Command Reference*\n\n` +

    `*General*\n` +
    `/start — welcome message + memory file status\n` +
    `/status — current model + session info\n` +
    `/clear — reset conversation history (memory files stay)\n` +
    `/help — this reference\n\n` +

    `*Memory*\n` +
    `/remember <text> — save a fact to memory.md\n` +
    `/memory <query> — search the memory index (full-text)\n` +
    `/doc <topic> — generate a Markdown doc → documents/\n\n` +

    `*Web Search*\n` +
    `/search <query> — DuckDuckGo search + Claude summary\n` +
    `_Natural language: "look up X", "research X", "what is X"_\n\n` +

    `*Goals*\n` +
    `/goals — interactive goal review session\n` +
    `/newgoal — AI-guided goal creation wizard\n` +
    `/confirm — save proposed goal + push actions to Todoist\n` +
    `/gstatus — list all goals with IDs and status\n` +
    `/gdelete <id> — permanently delete a goal\n` +
    `/gupdate <id> <status> — change status (active/paused/completed/archived)\n` +
    `/gmetric <id> <text> — log a metric update\n` +
    `/gadd <id> <action> — add an action to a goal\n` +
    `/goals_diagram — generate Excalidraw visual of goals\n` +
    `_Natural language: "review my goals", "create a new goal", "goal status"_\n\n` +

    `*Todoist*\n` +
    `/ttasks — show open Todoist tasks\n` +
    `/tsync — push goal actions → Todoist\n` +
    `/tpull — pull completed Todoist tasks → mark done in goals.md\n` +
    `/tclear <id> — delete all Todoist tasks for goal #id\n` +
    `_Natural language: "show todoist tasks", "sync to todoist"_\n\n` +

    `*Freedcamp*\n` +
    `/fc — show all Freedcamp projects + open tasks\n` +
    `/fc <question> — ask Claude about your Freedcamp tasks\n` +
    `/delete-task — guided task deletion flow\n\n` +

    `*Gmail*\n` +
    `/gauth — connect Google account (OAuth)\n` +
    `/gmail — show unread emails\n` +
    `/gsearch <query> — search Gmail\n` +
    `/gread <id> — read a full email\n` +
    `/gsummarise <id> — AI summary of an email\n` +
    `/gsend <to> | <subject> | <body> — send email\n` +
    `/greply <id> | <body> — reply to email\n` +
    `_Natural language: "check my email", "emails from X", "send email to X saying Y"_\n\n` +

    `*Google Drive*\n` +
    `/drive — list recent Drive files\n` +
    `/drsearch <query> — search Drive\n` +
    `/drread <id> — read a Drive file\n` +
    `/drcreate <title> | <content> — create a Google Doc\n` +
    `/drupdate <id> | <content> — update a Google Doc\n` +
    `_Natural language: "show my drive", "search drive for X", "find file X"_\n\n` +

    `*Google Calendar*\n` +
    `/gcal — show upcoming events (next 10)\n` +
    `/gcaltoday — show today's events\n` +
    `/gcalsearch <query> — search calendar events\n` +
    `/gcalevent <id> — show full event details\n` +
    `/gccreate <title> | <start> | <end> [| desc] [| loc] — create event\n` +
    `/gcdelete <id> — delete an event\n` +
    `_Natural language: "show my calendar", "what's on today", "schedule a meeting"_\n\n` +

    `*LinkedIn*\n` +
    `/linkedin — AI-guided LinkedIn post wizard (asks 4 questions)\n` +
    `/postit — save the proposed post to documents/linkedin-posts.md\n` +
    `_Natural language: "write a LinkedIn post", "create LinkedIn content"_\n\n` +

    `*Morning Briefing*\n` +
    `/morning — daily plan with tasks + Claude narrative\n` +
    `_Natural language: "plan my day", "morning briefing"_`
  );
});

bot.onText(/^\/clear(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  histories.delete(msg.chat.id);
  sessionContexts.delete(msg.chat.id);
  goalWizardState.delete(msg.chat.id);
  goalReviewState.delete(msg.chat.id);
  pendingGoalProposals.delete(msg.chat.id);
  linkedinWizardState.delete(msg.chat.id);
  pendingLinkedinPosts.delete(msg.chat.id);
  expertSessionState.delete(msg.chat.id);
  await send(msg.chat.id, 'Conversation history cleared. Memory files still loaded.');
});

bot.onText(/^\/dashboard(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  if (!dashboard) {
    await send(chatId, 'Dashboard is not running.');
    return;
  }
  const token = dashboard.createTokenForUser(String(msg.from.id));
  const link = `${DASHBOARD_URL}/d?t=${token}`;
  await send(chatId, `Your dashboard (valid 7 days):\n${link}`);
});

bot.onText(/^\/status(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;

  const today = todayStr();
  const files = [
    ['soul.md', join(ROOT, 'soul.md')],
    ['user.md', join(ROOT, 'user.md')],
    ['memory.md', join(ROOT, 'memory.md')],
    [`memory/${today}.md`, join(MEMORY_DIR, `${today}.md`)],
  ];
  const fileStatus = files
    .map(([name, p]) => `${existsSync(p) ? '✓' : '✗'} \`${name}\``)
    .join('\n');

  const turns = Math.floor((histories.get(msg.chat.id)?.length ?? 0) / 2);

  await send(msg.chat.id,
    `*Memory files:*\n${fileStatus}\n\n` +
    `*Model:* \`${CLAUDE_MODEL}\`\n` +
    `*Conversation turns this session:* ${turns}`
  );
});

bot.onText(/^\/search(@\S+)? (.+)/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  await handleWebSearch(msg.chat.id, match[2].trim());
});

bot.onText(/^\/memory(@\S+)? (.+)/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;

  const query = match[2].trim();
  await bot.sendChatAction(msg.chat.id, 'typing').catch(() => { });

  try {
    const { stdout } = await execFileAsync(
      'node', ['memory_manager.mjs', 'search', query],
      { cwd: ROOT }
    );
    const clean = stdout
      .replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '')
      .trim();
    await send(msg.chat.id, clean || `No results in memory for: "${query}"`);
  } catch (err) {
    await send(msg.chat.id, `Memory search error: ${err.message}`);
  }
});

bot.onText(/^\/remember(@\S+)? (.+)/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;

  const text = match[2].trim();
  try {
    appendToMemoryMd(text);
    reindexInBackground();
    await send(msg.chat.id, `Saved to \`memory.md\`:\n_${text}_`);
  } catch (err) {
    await send(msg.chat.id, `Could not write to memory.md: ${err.message}`);
  }
});

bot.onText(/^\/doc(@\S+)? (.+)/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const result = await handleDocCreation(msg.chat.id, match[2].trim());
  if (result) appendExchangeToLog(`/doc ${result.topic}`, `Document saved: ${result.filePath}`);
});

bot.onText(/^\/slides(@\S+)? (.+)/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const result = await handleSlidesCreation(msg.chat.id, match[2].trim());
  if (result) appendExchangeToLog(`/slides ${result.topic}`, `Presentation: ${result.url}`);
});

bot.onText(/^\/fc(@\S+)?(.*)/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;

  const chatId = msg.chat.id;
  const question = (match[2] ?? '').trim();

  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  let fcContext;
  try {
    fcContext = await getFreedcampContext();
  } catch (err) {
    await send(chatId, `Freedcamp error: ${err.message}`);
    return;
  }

  if (!question) {
    // No question — just dump the raw snapshot
    await send(chatId, fcContext);
    appendExchangeToLog('/fc', fcContext);
    return;
  }

  // Intercept close/complete task commands within /fc
  const fcCloseMatch = question.match(/(?:close|complete|finish|done|mark done|cerrar|completar|terminar)\s+(?:all\s+)?(?:tasks?|tareas?)\s+(?:for|in|from|of|de|en|para)\s+(.+)/i);
  if (fcCloseMatch) {
    const projectName = fcCloseMatch[1].replace(/[?!.,]+$/, '').trim();
    try {
      const projects = await getFcProjects();
      const project = projects.find(p => p.project_name.toLowerCase().includes(projectName.toLowerCase()));
      if (!project) {
        await send(chatId, `No Freedcamp project found matching "${projectName}". Use /fc to see projects.`);
        return;
      }
      const tasks = await getFcTasks(project.id);
      if (tasks.length === 0) {
        await send(chatId, `No open tasks in *${project.project_name}*.`);
        return;
      }
      await Promise.all(tasks.map(t => fcCompleteTask(t.id)));
      await send(chatId, `Completed ${tasks.length} task(s) in Freedcamp project *${project.project_name}*.`);
      appendExchangeToLog(`/fc ${question}`, `Completed ${tasks.length} Freedcamp tasks in ${project.project_name}`);
    } catch (err) { await send(chatId, `Freedcamp error: ${err.message}`); }
    return;
  }

  // Question provided — have Claude analyze with Freedcamp context
  const reply = await handleFreedcampQuery(chatId, question);
  if (reply) appendExchangeToLog(`/fc ${question}`, stripStructuredBlocks(reply));
});

// ─── New goal wizard ──────────────────────────────────────────────────────────

bot.onText(/^\/newgoal(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  if (processing.has(chatId)) return;
  processing.add(chatId);
  try { await startGoalWizard(chatId); }
  finally { processing.delete(chatId); }
});

bot.onText(/^\/confirm(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  await confirmGoal(msg.chat.id);
});

bot.onText(/^\/linkedin(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  await startLinkedinWizard(msg.chat.id);
});

bot.onText(/^\/postit(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  await confirmLinkedinPost(msg.chat.id);
});

bot.onText(/^\/morning(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  await startMorningBriefing(msg.chat.id);
});

// ─── /schedule command ──────────────────────────────────────────────────────

bot.onText(/^\/schedule(@\S+)?\s*(.*)$/s, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const args = (match[2] || '').trim();

  // Helper: open DB, run fn, close
  async function withDb(fn) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(ROOT, 'memory.db'));
    try { return fn(db); } finally { db.close(); }
  }

  // No args → show current schedules
  if (!args) {
    const morning = process.env.SCHEDULE_MORNING || null;
    const weekly = process.env.SCHEDULE_WEEKLY || null;
    const lines = ['*Scheduled briefings*\n'];
    lines.push(morning
      ? `Morning briefing: *${morning}* (daily)`
      : 'Morning briefing: _not configured_');
    lines.push(weekly
      ? `Weekly summary: *${weekly}*`
      : 'Weekly summary: _not configured_');
    lines.push('\n_Commands:_');
    lines.push('`/schedule morning 08:30` — set daily briefing');
    lines.push('`/schedule weekly FRI:16:00` — set weekly summary');
    lines.push('`/schedule off morning` — disable morning');
    lines.push('`/schedule off weekly` — disable weekly');
    await send(chatId, lines.join('\n'));
    return;
  }

  // /schedule off <type>
  const offMatch = args.match(/^off\s+(morning|weekly)$/i);
  if (offMatch) {
    const type = offMatch[1].toLowerCase();
    const envKey = type === 'morning' ? 'SCHEDULE_MORNING' : 'SCHEDULE_WEEKLY';
    delete process.env[envKey];
    await withDb(db => deleteConfig(db, envKey));
    restartScheduler();
    await send(chatId, `${type === 'morning' ? 'Morning briefing' : 'Weekly summary'} disabled.`);
    return;
  }

  // /schedule morning HH:MM
  const morningMatch = args.match(/^morning\s+(\d{1,2}):(\d{2})$/i);
  if (morningMatch) {
    const h = parseInt(morningMatch[1], 10);
    const m = parseInt(morningMatch[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      await send(chatId, 'Invalid time. Use HH:MM format (00:00-23:59).');
      return;
    }
    const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    process.env.SCHEDULE_MORNING = value;
    await withDb(db => setConfig(db, 'SCHEDULE_MORNING', value));
    restartScheduler();
    await send(chatId, `Morning briefing set to *${value}* daily.`);
    return;
  }

  // /schedule weekly DAY:HH:MM
  const weeklyMatch = args.match(/^weekly\s+(MON|TUE|WED|THU|FRI|SAT|SUN):(\d{1,2}):(\d{2})$/i);
  if (weeklyMatch) {
    const day = weeklyMatch[1].toUpperCase();
    const h = parseInt(weeklyMatch[2], 10);
    const m = parseInt(weeklyMatch[3], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      await send(chatId, 'Invalid time. Use DAY:HH:MM format (e.g. FRI:16:00).');
      return;
    }
    const value = `${day}:${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    process.env.SCHEDULE_WEEKLY = value;
    await withDb(db => setConfig(db, 'SCHEDULE_WEEKLY', value));
    restartScheduler();
    const dayNames = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };
    await send(chatId, `Weekly summary set to *${dayNames[day]} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}*.`);
    return;
  }

  await send(chatId, 'Usage:\n`/schedule` — show current\n`/schedule morning 08:30`\n`/schedule weekly FRI:16:00`\n`/schedule off morning`\n`/schedule off weekly`');
});

// /expert [topic] — start super team expert session
bot.onText(/^\/expert(@\S+)?(\s+.+)?$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  if (processing.has(chatId)) return;
  processing.add(chatId);
  try {
    const hint = match[2]?.trim() || null;
    await startExpertSession(chatId, hint);
  } finally { processing.delete(chatId); }
});

bot.onText(/^\/gdelete(@\S+)? (\d+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const id = match[2];
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const { stdout } = await execFileAsync('node', ['goals_manager.mjs', 'delete', id], { cwd: ROOT });
    const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    await send(chatId, clean || `Goal #${id} deleted.`);
    appendExchangeToLog(`/gdelete ${id}`, clean);
  } catch (err) {
    await send(chatId, `Delete error: ${err.message}`);
  }
});

// ─── Goal status ──────────────────────────────────────────────────────────────

bot.onText(/^\/gstatus(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  try {
    const { stdout } = await execFileAsync('node', ['goals_manager.mjs', 'stats'], { cwd: ROOT });
    const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    const list = await execFileAsync('node', ['goals_manager.mjs', 'list'], { cwd: ROOT });
    const listClean = list.stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    await send(chatId, `*Goal Status*\n\n${clean}\n\n${listClean}`);
  } catch (err) {
    await send(chatId, `Goal status error: ${err.message}`);
  }
});

// ─── Goal with inline text → start wizard with context ───────────────────────

bot.onText(/^\/goals?(@\S+)?\s+(.+)$/i, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  if (processing.has(chatId)) return;
  processing.add(chatId);
  try {
  const inlineText = match[2].trim();
  console.log('[goal] inline goal text:', inlineText);

  // Start wizard, then immediately feed the inline text as the user's first answer
  const skill = readSafe(join(ROOT, '.claude', 'skills', 'new-goal', 'SKILL.md'));
  if (!skill) { await send(chatId, 'Goal wizard skill file not found.'); return; }

  goalWizardState.set(chatId, 'active');
  goalReviewState.delete(chatId);
  histories.delete(chatId);
  sessionContexts.set(chatId, `# New Goal Wizard — follow these steps exactly\n\n${skill}`);

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const reply = await askClaude(chatId, `I want to set a goal: ${inlineText}`);
    const proposal = parseGoalProposal(reply);
    if (proposal) {
      pendingGoalProposals.set(chatId, proposal);
      await send(chatId, formatProposalForTelegram(proposal));
      await send(chatId, 'Say *confirm* (or /confirm) to save + push to Todoist, or describe any changes.');
    } else {
      await send(chatId, stripStructuredBlocks(reply));
    }
    appendExchangeToLog(`/goal ${inlineText}`, stripStructuredBlocks(reply));
  } catch (err) {
    console.error('[goal inline] ERROR:', err.message);
    goalWizardState.delete(chatId);
    sessionContexts.delete(chatId);
    await send(chatId, `Goal wizard error: ${err.message}`).catch(() => { });
  }
  } finally { processing.delete(chatId); }
});

// ─── Goals skill ──────────────────────────────────────────────────────────────

bot.onText(/^\/goals(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  if (processing.has(chatId)) return;
  processing.add(chatId);
  console.log('[goals] command received from user', msg.from.id, 'in chat', chatId);

  // Check if goals.md has any actual goals (## headings after the header)
  const goalsContent = readSafe(join(ROOT, 'goals.md')) || '';
  const hasGoals = /\n## .+/.test(goalsContent);

  if (!hasGoals) {
    console.log('[goals] goals.md is empty — redirecting to /newgoal wizard');
    await send(chatId, 'No goals found yet. Starting the goal creation wizard...');
    await startGoalWizard(chatId);
    return;
  }

  try {
    await send(chatId, 'Starting goal review session... (this may take 30–60 seconds)');
  } catch (sendErr) {
    console.error('[goals] failed to send initial message:', sendErr.message);
    return;
  }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  const hormoziPath = join(ROOT, '.claude', 'skills', 'goals', 'hormozi.md');
  const hormozi = readSafe(hormoziPath);

  console.log('[goals] files loaded — hormozi:', !!hormozi, '| goals:', !!goalsContent);

  // Pre-run goals_manager.mjs list so Claude has IDs without needing to run commands
  let goalsList = '';
  try {
    const { stdout } = await execFileAsync('node', ['goals_manager.mjs', 'list'], { cwd: ROOT });
    goalsList = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
  } catch (_) { /* ignore — goals.md content is the fallback */ }

  // IMPORTANT: Do NOT load the raw goals SKILL.md here — it tells Claude to edit
  // files and run bash commands, which is impossible in --print text-only mode.
  // Instead, provide a self-contained review guide with GOAL_CHANGES structured output.
  const reviewGuide = `
# Goal Review Session — Instructions

You are conducting a goal review session through Telegram. You are in TEXT-ONLY mode.
You CANNOT edit files. You CANNOT run bash commands. You CANNOT write to goals.md.
NEVER ask for permission to write files. NEVER mention running node commands.

## How the review works

1. Present a brief summary of each active goal: title, status, pending vs completed actions, last reviewed date.
2. Share the lens briefly: "Goals flow from intrinsic motivation, approached playfully with non-attachment. Enjoyment is the signal."
3. For each active goal, state what you see, then ask: "What actually happened with this since last review? Anything stalled or needs to change?"
4. Wait for the user's answer before moving to the next goal.
5. Based on their answers, record changes using the GOAL_CHANGES format below.
6. At the end, summarize what changed this session.

## How to make changes — GOAL_CHANGES format

When you want to check off actions, add actions, log metrics, or change status,
output a GOAL_CHANGES block at the END of your reply (after your conversational text).
The bot will parse this and apply the changes to goals.md automatically.

Format:
GOAL_CHANGES
DONE|<exact goal title from ## heading>|<exact action text from the - [ ] line>
ADD|<exact goal title>|<new action text to add>
METRIC|<exact goal title>|<metric update text>
STATUS|<exact goal title>|<new status: active/paused/completed/archived>
REVIEWED|<exact goal title>
END_GOAL_CHANGES

Rules:
- Goal titles MUST match exactly as they appear after ## in goals.md
- For DONE, the action text must match the text after - [ ] in goals.md
- Include REVIEWED|<title> for each goal you discuss
- Only output the block when you have changes — not in every reply
- If the user wants to create a NEW goal, tell them to type /newgoal or /goal <description>
- NEVER say "I need permission to write" or "please approve the file write" — just use the format above
- NEVER mention running node commands — the bot handles indexing
`;

  const extra = [
    reviewGuide,
    hormozi && `# Hormozi Reference\n\n${hormozi}`,
    goalsList && `# Current goals (from goals_manager.mjs list)\n\n${goalsList}`,
    goalsContent && `# goals.md (current goal state — source of truth)\n\n${goalsContent}`,
  ].filter(Boolean).join('\n\n---\n\n');

  // Fresh session with goals context loaded
  histories.delete(chatId);
  sessionContexts.set(chatId, extra);
  goalReviewState.set(chatId, true);

  try {
    console.log('[goals] calling askClaude...');
    const reply = await askClaude(chatId, 'Begin the goal review session. Follow the review guide. Start by presenting the current state of goals.');
    console.log('[goals] reply received, length:', reply.length);

    // Check for structured changes in the reply
    const changes = parseGoalChanges(reply);
    if (changes) {
      const result = applyGoalChanges(changes);
      console.log('[goals] applied changes:', result);
      reindexInBackground();
    }

    await send(chatId, stripStructuredBlocks(reply));
    appendExchangeToLog('/goals', stripStructuredBlocks(reply));
  } catch (err) {
    console.error('[goals] ERROR:', err.message);
    await send(chatId, `Goals error: ${err.message}`).catch(() => { });
  } finally {
    processing.delete(chatId);
  }
});

// ─── Goal quick-edit commands ─────────────────────────────────────────────────

bot.onText(/^\/gupdate(@\S+)? (\d+) (\S+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  try {
    const { stdout } = await execFileAsync(
      'node', ['goals_manager.mjs', 'update', match[2], match[3]],
      { cwd: ROOT }
    );
    const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    await send(chatId, clean || `Goal #${match[2]} updated to ${match[3]}`);
  } catch (err) {
    await send(chatId, `Error: ${err.message}`);
  }
});

bot.onText(/^\/gmetric(@\S+)? (\d+) (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  try {
    const { stdout } = await execFileAsync(
      'node', ['goals_manager.mjs', 'metric', match[2], match[3]],
      { cwd: ROOT }
    );
    const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    await send(chatId, clean || `Metric logged for goal #${match[2]}`);
  } catch (err) {
    await send(chatId, `Error: ${err.message}`);
  }
});

bot.onText(/^\/gadd(@\S+)? (\d+) (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  try {
    const { stdout } = await execFileAsync(
      'node', ['goals_manager.mjs', 'add-action', match[2], match[3]],
      { cwd: ROOT }
    );
    const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    await send(chatId, clean || `Action added to goal #${match[2]}`);
  } catch (err) {
    await send(chatId, `Error: ${err.message}`);
  }
});

// ─── Todoist ──────────────────────────────────────────────────────────────────

bot.onText(/^\/tsync(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;

  await send(chatId, 'Syncing goals to Todoist...');
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  try {
    const { stdout, stderr } = await execFileAsync(
      'node', ['scripts/sync-goals-todoist.mjs'],
      { cwd: ROOT }
    );
    const out = (stdout + stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    await send(chatId, `*Todoist sync complete*\n\`\`\`\n${out}\n\`\`\``);
    appendExchangeToLog('/tsync', out);
  } catch (err) {
    console.error('[tsync] ERROR:', err.message);
    await send(chatId, `Todoist sync error: ${err.message}`);
  }
});

bot.onText(/^\/ttasks(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  try {
    const context = await getTodoistContext();
    await send(chatId, context && context.trim() ? context : 'Todoist: no tasks found.');
  } catch (err) {
    console.error('[ttasks] error:', err);
    await send(chatId, `Todoist error: ${err.message}`);
  }
});

bot.onText(/^\/tclear(@\S+)?( \d+)?$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const goalNum = match[2]?.trim();

  if (!goalNum) {
    // No number — list goals so user knows what to type
    try {
      const { stdout } = await execFileAsync(
        'node', ['scripts/clear-todoist-tasks.mjs'],
        { cwd: ROOT }
      );
      const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
      await send(chatId, `${clean}\n\nType \`/tclear <number>\` to delete all Todoist tasks for that goal.`);
    } catch (err) {
      await send(chatId, `Error: ${err.message}`);
    }
    return;
  }

  await send(chatId, `Deleting Todoist tasks for goal #${goalNum}...`);
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  try {
    const { stdout, stderr } = await execFileAsync(
      'node', ['scripts/clear-todoist-tasks.mjs', goalNum],
      { cwd: ROOT }
    );
    const out = (stdout + stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    await send(chatId, `*Todoist clear complete*\n\`\`\`\n${out}\n\`\`\``);
    appendExchangeToLog(`/tclear ${goalNum}`, out);
  } catch (err) {
    console.error('[tclear] ERROR:', err.message);
    await send(chatId, `Todoist clear error: ${err.message}`);
  }
});

bot.onText(/^\/tpull(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;

  await send(chatId, 'Pulling completed Todoist tasks into goals.md...');
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  try {
    const { stdout, stderr } = await execFileAsync(
      'node', ['scripts/pull-todoist-goals.mjs'],
      { cwd: ROOT }
    );
    const out = (stdout + stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
    await send(chatId, `*Todoist pull complete*\n\`\`\`\n${out}\n\`\`\``);
    appendExchangeToLog('/tpull', out);
  } catch (err) {
    console.error('[tpull] ERROR:', err.message);
    await send(chatId, `Todoist pull error: ${err.message}`);
  }
});

// ─── Goals diagram ────────────────────────────────────────────────────────────

bot.onText(/^\/goals_diagram(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;

  await send(chatId, 'Generating goals diagram...');
  await bot.sendChatAction(chatId, 'upload_document').catch(() => { });

  try {
    // Ensure goals are indexed
    await execFileAsync('node', ['goals_manager.mjs', 'index'], { cwd: ROOT });

    // Generate the diagram
    const { stdout } = await execFileAsync(
      'node', ['scripts/generate-goals-diagram.mjs'],
      { cwd: ROOT }
    );
    const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();

    const diagramPath = join(ROOT, 'documents', 'goals-diagram.excalidraw');
    if (!existsSync(diagramPath)) {
      await send(chatId, 'Diagram file not found after generation. Check VPS logs.');
      return;
    }

    // Send the file directly via Telegram
    await bot.sendDocument(chatId, diagramPath, {
      caption:
        'Open at excalidraw.com: File → Open → select this file.\n' +
        'Or drag it directly into the excalidraw.com browser tab.\n\n' +
        'Blue = active  |  Yellow = paused  |  Green = completed  |  Gray = archived',
    });

    appendExchangeToLog('/goals-diagram', clean);
  } catch (err) {
    console.error('[goals-diagram] ERROR:', err.message);
    await send(chatId, `Goals diagram error: ${err.message}`);
  }
});

// ─── Google Auth ──────────────────────────────────────────────────────────────

bot.onText(/^\/gauth(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;

  if (isGoogleAuthorised()) {
    await send(chatId, 'Google is already authorised. Use /gauth reset to re-authorise.');
    return;
  }

  // Prefer Vercel OAuth handler (HTTPS, automatic token exchange)
  const oauthHandlerUrl = process.env.OAUTH_HANDLER_URL;
  const dashboardUrl = process.env.DASHBOARD_URL;
  if (oauthHandlerUrl && dashboardUrl) {
    const vercelUrl = `${oauthHandlerUrl}?callback=${encodeURIComponent(dashboardUrl)}&from=${encodeURIComponent('/setup/google')}`;
    await send(chatId,
      '*Google OAuth setup*\n\n' +
      'Click the link below to connect your Google account:\n' +
      `${vercelUrl}\n\n` +
      '_Tokens will be saved automatically after you grant access._'
    );
    return;
  }

  // Fallback: direct OAuth flow (requires GOOGLE_REDIRECT_URI)
  const url = getAuthUrl();
  await send(chatId,
    '*Google OAuth setup*\n\n' +
    '1. Visit this URL and grant access:\n' +
    `\`${url}\`\n\n` +
    '2. Copy the authorisation code and reply with:\n' +
    '`/gauthcode <paste-code-here>`'
  );
});

bot.onText(/^\/gauth(@\S+)? reset$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const { unlinkSync } = await import('node:fs');
  const tokenPath = resolve(ROOT, '.google-tokens.json');
  try { unlinkSync(tokenPath); } catch { /* already gone */ }
  await send(msg.chat.id, 'Google tokens cleared. Use /gauth to re-authorise.');
});

bot.onText(/^\/gauthcode(@\S+)? (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const code   = match[2].trim();
  try {
    await exchangeCode(code);
    await send(chatId, 'Google authorised. Gmail, Drive, and Calendar commands are now active.');
  } catch (err) {
    await send(chatId, `Authorisation failed: ${err.message}`);
  }
});

// ─── Gmail ────────────────────────────────────────────────────────────────────

bot.onText(/^\/gmail(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;

  if (!isGoogleAuthorised()) {
    await send(chatId, 'Google not authorised. Run /gauth first.');
    return;
  }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const emails = await getUnread(10);
    if (emails.length === 0) {
      await send(chatId, 'No unread emails.');
      return;
    }
    const lines = [`*Gmail — ${emails.length} unread*`, ''];
    emails.forEach((e, i) => {
      lines.push(`*${i + 1}.* ${e.subject}`);
      lines.push(`From: ${e.from}`);
      lines.push(`_${e.snippet.slice(0, 150)}_`);
      lines.push(`ID: \`${e.id}\``);
      lines.push('');
    });
    await send(chatId, lines.join('\n'));
  } catch (err) { await send(chatId, `Gmail error: ${err.message}`); }
});

bot.onText(/^\/gsearch(@\S+)? (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const query  = match[2].trim();

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const emails = await searchEmails(query, 10);
    if (emails.length === 0) {
      await send(chatId, `No emails found for: _${query}_`);
      return;
    }
    const lines = [`*Gmail search: "${query}" — ${emails.length} results*`, ''];
    emails.forEach((e, i) => {
      lines.push(`*${i + 1}.* ${e.subject}`);
      lines.push(`From: ${e.from}  |  ${e.date?.slice(0, 16) ?? ''}`);
      lines.push(`_${e.snippet.slice(0, 150)}_`);
      lines.push(`ID: \`${e.id}\``);
      lines.push('');
    });
    await send(chatId, lines.join('\n'));
  } catch (err) { await send(chatId, `Gmail search error: ${err.message}`); }
});

// /gread <messageId> — fetch full email and summarise with Claude
bot.onText(/^\/gread(@\S+)? (\S+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId    = msg.chat.id;
  const messageId = match[2].trim();

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const email = await getEmail(messageId);
    const preview =
      `*${email.subject}*\n` +
      `From: ${email.from}\n` +
      `Date: ${email.date}\n\n` +
      email.body.slice(0, 3000);
    await send(chatId, preview);
  } catch (err) { await send(chatId, `Gmail read error: ${err.message}`); }
});

// /gsummarise <messageId> — AI summary of email
bot.onText(/^\/gsummarise(@\S+)? (\S+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId    = msg.chat.id;
  const messageId = match[2].trim();

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const email   = await getEmail(messageId);
    const prompt  = `Summarise this email concisely. Extract: key points, action items required, deadline if any.\n\nFrom: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.body}`;
    const summary = await askClaude(chatId, prompt);
    await send(chatId, summary);
    appendExchangeToLog(`/gsummarise ${messageId}`, summary);
  } catch (err) { await send(chatId, `Summarise error: ${err.message}`); }
});

// /gsend <to> | <subject> | <body>
bot.onText(/^\/gsend(@\S+)? (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const parts  = match[2].split('|').map(s => s.trim());

  if (parts.length < 3) {
    await send(chatId, 'Usage: `/gsend <to> | <subject> | <body>`');
    return;
  }

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  const [to, subject, body] = parts;
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    await sendEmail(to, subject, body);
    await send(chatId, `Email sent to ${to}.`);
    appendExchangeToLog(`/gsend to:${to} subject:${subject}`, 'Email sent.');
  } catch (err) { await send(chatId, `Send error: ${err.message}`); }
});

// /greply <messageId> | <body>
bot.onText(/^\/greply(@\S+)? (\S+) \| (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId    = msg.chat.id;
  const messageId = match[2].trim();
  const body      = match[3].trim();

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    await replyEmail(messageId, body);
    await send(chatId, 'Reply sent.');
    appendExchangeToLog(`/greply ${messageId}`, 'Reply sent.');
  } catch (err) { await send(chatId, `Reply error: ${err.message}`); }
});

// ─── Google Drive ─────────────────────────────────────────────────────────────

bot.onText(/^\/drive(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const files = await listRecent(10);
    if (files.length === 0) { await send(chatId, 'No files found in Drive.'); return; }

    const lines = [`*Google Drive — ${files.length} recent files*`, ''];
    files.forEach((f, i) => {
      const type     = f.mimeType.split('.').pop().replace('google-apps.', '');
      const modified = f.modifiedTime?.slice(0, 10) ?? '';
      lines.push(`*${i + 1}.* ${f.name}`);
      lines.push(`Type: ${type}  |  Modified: ${modified}`);
      lines.push(`ID: \`${f.id}\``);
      lines.push('');
    });
    await send(chatId, lines.join('\n'));
  } catch (err) { await send(chatId, `Drive error: ${err.message}`); }
});

bot.onText(/^\/drsearch(@\S+)? (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const query  = match[2].trim();

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const files = await searchFiles(query, 10);
    if (files.length === 0) { await send(chatId, `No Drive files found for: _${query}_`); return; }

    const lines = [`*Drive search: "${query}" — ${files.length} results*`, ''];
    files.forEach((f, i) => {
      const type     = f.mimeType.split('.').pop().replace('google-apps.', '');
      const modified = f.modifiedTime?.slice(0, 10) ?? '';
      lines.push(`*${i + 1}.* ${f.name}`);
      lines.push(`Type: ${type}  |  Modified: ${modified}`);
      lines.push(`ID: \`${f.id}\``);
      lines.push('');
    });
    await send(chatId, lines.join('\n'));
  } catch (err) { await send(chatId, `Drive search error: ${err.message}`); }
});

// /drread <fileId> — read and display file content
bot.onText(/^\/drread(@\S+)? (\S+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const fileId = match[2].trim();

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const file = await readFile(fileId);
    const preview =
      `*${file.name}*\n` +
      `Type: ${file.mimeType}\n\n` +
      file.content.slice(0, 3500);
    await send(chatId, preview);
  } catch (err) { await send(chatId, `Drive read error: ${err.message}`); }
});

// /drcreate <title> | <content>
bot.onText(/^\/drcreate(@\S+)? (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const parts  = match[2].split('|').map(s => s.trim());

  if (parts.length < 2) {
    await send(chatId, 'Usage: `/drcreate <title> | <content>`');
    return;
  }

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  const [title, content] = parts;
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const fileId = await createDoc(title, content);
    await send(chatId, `Doc created: *${title}*\nID: \`${fileId}\``);
    appendExchangeToLog(`/drcreate "${title}"`, `Created Drive doc ${fileId}`);
  } catch (err) { await send(chatId, `Drive create error: ${err.message}`); }
});

// /drupdate <fileId> | <new content>
bot.onText(/^\/drupdate(@\S+)? (\S+) \| (.+)$/s, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId  = msg.chat.id;
  const fileId  = match[2].trim();
  const content = match[3].trim();

  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }

  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    await updateDoc(fileId, content);
    await send(chatId, `Doc \`${fileId}\` updated.`);
    appendExchangeToLog(`/drupdate ${fileId}`, 'Doc updated.');
  } catch (err) { await send(chatId, `Drive update error: ${err.message}`); }
});

// ─── Google Calendar ──────────────────────────────────────────────────────────

// /gcal — show upcoming events
bot.onText(/^\/gcal(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const events = await getUpcomingEvents(10);
    if (events.length === 0) { await send(chatId, 'No upcoming events.'); return; }
    const lines = [`*Calendar — ${events.length} upcoming events*`, ''];
    events.forEach((e, i) => {
      lines.push(`*${i + 1}.* ${e.title}`);
      lines.push(`${e.start} → ${e.end}`);
      if (e.location) lines.push(`Location: ${e.location}`);
      lines.push(`ID: \`${e.id}\``);
      lines.push('');
    });
    await send(chatId, lines.join('\n'));
  } catch (err) { await send(chatId, `Calendar error: ${err.message}`); }
});

// /gcaltoday — show today's events
bot.onText(/^\/gcaltoday(@\S+)?$/, async (msg) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const events = await getTodayEvents();
    if (events.length === 0) { await send(chatId, 'No events today.'); return; }
    const lines = [`*Today's events (${events.length})*`, ''];
    events.forEach((e, i) => {
      lines.push(`*${i + 1}.* ${e.title}`);
      lines.push(`${e.start} → ${e.end}`);
      if (e.location) lines.push(`Location: ${e.location}`);
      lines.push(`ID: \`${e.id}\``);
      lines.push('');
    });
    await send(chatId, lines.join('\n'));
  } catch (err) { await send(chatId, `Calendar error: ${err.message}`); }
});

// /gcalsearch <query> — search calendar events
bot.onText(/^\/gcalsearch(@\S+)? (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const query  = match[2].trim();
  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const events = await searchCalEvents(query, 10);
    if (events.length === 0) { await send(chatId, `No calendar events found for: _${query}_`); return; }
    const lines = [`*Calendar search: "${query}" — ${events.length} results*`, ''];
    events.forEach((e, i) => {
      lines.push(`*${i + 1}.* ${e.title}`);
      lines.push(`${e.start} → ${e.end}`);
      if (e.location) lines.push(`Location: ${e.location}`);
      lines.push(`ID: \`${e.id}\``);
      lines.push('');
    });
    await send(chatId, lines.join('\n'));
  } catch (err) { await send(chatId, `Calendar search error: ${err.message}`); }
});

// /gcalevent <eventId> — show full event details
bot.onText(/^\/gcalevent(@\S+)? (\S+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId  = msg.chat.id;
  const eventId = match[2].trim();
  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const event = await getEvent(eventId);
    const lines = [
      `*${event.title}*`,
      `Start: ${event.start}`,
      `End: ${event.end}`,
    ];
    if (event.location)    lines.push(`Location: ${event.location}`);
    if (event.description) lines.push(`\n${event.description.slice(0, 2000)}`);
    if (event.attendees.length > 0) lines.push(`\nAttendees: ${event.attendees.join(', ')}`);
    if (event.link) lines.push(`\n${event.link}`);
    await send(chatId, lines.join('\n'));
  } catch (err) { await send(chatId, `Calendar event error: ${err.message}`); }
});

// /gccreate <title> | <start> | <end> [| description] [| location]
bot.onText(/^\/gccreate(@\S+)? (.+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId = msg.chat.id;
  const parts  = match[2].split('|').map(s => s.trim());
  if (parts.length < 3) {
    await send(chatId, 'Usage: `/gccreate <title> | <start ISO> | <end ISO> [| description] [| location]`\n\nExample:\n`/gccreate Team meeting | 2026-03-05T15:00 | 2026-03-05T16:00 | Weekly sync | Zoom`');
    return;
  }
  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
  const [title, start, end, description, location] = parts;
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    const result = await createEvent(title, start, end, description ?? '', location ?? '');
    await send(chatId, `Event created: *${title}*\nID: \`${result.id}\`\n${result.link}`);
    appendExchangeToLog(`/gccreate "${title}"`, `Created calendar event ${result.id}`);
  } catch (err) { await send(chatId, `Calendar create error: ${err.message}`); }
});

// /gcdelete <eventId> — delete an event
bot.onText(/^\/gcdelete(@\S+)? (\S+)$/, async (msg, match) => {
  if (!authorized(msg.from.id)) return;
  const chatId  = msg.chat.id;
  const eventId = match[2].trim();
  if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
  await bot.sendChatAction(chatId, 'typing').catch(() => { });
  try {
    await deleteEvent(eventId);
    await send(chatId, `Event \`${eventId}\` deleted.`);
    appendExchangeToLog(`/gcdelete ${eventId}`, 'Calendar event deleted.');
  } catch (err) { await send(chatId, `Calendar delete error: ${err.message}`); }
});

// ─── Main message handler ─────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  if (!authorized(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, 'Unauthorized.');
    return;
  }

  const chatId = msg.chat.id;

  if (processing.has(chatId)) {
    await bot.sendMessage(chatId, '(Still thinking — send again in a moment.)');
    return;
  }

  processing.add(chatId);
  await bot.sendChatAction(chatId, 'typing').catch(() => { });

  try {
    // ─── LinkedIn wizard (active conversation) ────────────────────────────────
    if (linkedinWizardState.get(chatId) === 'active') {
      const reply = await askClaude(chatId, msg.text);
      const proposal = parsePostProposal(reply);
      if (proposal) {
        pendingLinkedinPosts.set(chatId, proposal);
        await send(chatId, formatPostForTelegram(proposal));
        await send(chatId, 'Say *postit* (or /postit) to save this post, or describe any changes.');
      } else {
        await send(chatId, stripStructuredBlocks(reply));
      }
      appendExchangeToLog(msg.text, stripStructuredBlocks(reply));
      return;
    }

    // Confirm pending LinkedIn post
    if (pendingLinkedinPosts.has(chatId) && NL_POSTIT_RE.test(msg.text.trim())) {
      await confirmLinkedinPost(chatId);
      return;
    }

    // ─── Expert session (active conversation) ──────────────────────────────────
    if (expertSessionState.has(chatId)) {
      const reply = await askClaude(chatId, msg.text);
      const summary = parseSessionSummary(reply);
      if (summary) {
        await send(chatId, stripSessionSummary(stripStructuredBlocks(reply)));
        await saveExpertDocument(chatId, summary);
        expertSessionState.delete(chatId);
        sessionContexts.delete(chatId);
        reindexInBackground();
      } else {
        await send(chatId, stripSessionSummary(stripStructuredBlocks(reply)));
      }
      appendExchangeToLog(msg.text, stripSessionSummary(stripStructuredBlocks(reply)));
      return;
    }

    // ─── Goal wizard (active conversation) ────────────────────────────────────
    if (goalWizardState.get(chatId) === 'active') {
      const reply = await askClaude(chatId, msg.text);
      const proposal = parseGoalProposal(reply);
      if (proposal) {
        pendingGoalProposals.set(chatId, proposal);
        await send(chatId, formatProposalForTelegram(proposal));
        await send(chatId, 'Say *confirm* (or /confirm) to save + push to Todoist, or describe any changes.');
      } else {
        await send(chatId, stripStructuredBlocks(reply));
      }
      appendExchangeToLog(msg.text, stripStructuredBlocks(reply));
      return;
    }

    // ─── Natural language intent detection ────────────────────────────────────

    // Confirm pending goal proposal
    if (pendingGoalProposals.has(chatId) && NL_CONFIRM_RE.test(msg.text.trim())) {
      await confirmGoal(chatId);
      return;
    }

    // Delete a goal
    const deleteMatch = msg.text.match(NL_GDELETE_RE);
    if (deleteMatch) {
      const id = deleteMatch[2];
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const { stdout } = await execFileAsync('node', ['goals_manager.mjs', 'delete', id], { cwd: ROOT });
        const clean = stdout.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
        await send(chatId, clean || `Goal #${id} deleted.`);
        appendExchangeToLog(msg.text, clean);
      } catch (err) { await send(chatId, `Delete error: ${err.message}`); }
      return;
    }

    // Inside a /goals review — handle the conversation and parse structured changes
    if (goalReviewState.get(chatId)) {
      // Check if user wants to create a NEW goal instead of reviewing
      const GOAL_INTENT_RE = /\b(add|create|set|want to add|need to add|want a new|need a new|nuevo|nueva|agregar).{0,20}\b(goal|objective|objetivo|meta)\b/i;
      const GOAL_ABOUT_RE  = /\b(goal|objective|objetivo|meta)\s+(about|of|to|for|is|de|para|sobre)\s+/i;
      if (NL_NEW_GOAL_RE.test(msg.text) || GOAL_INTENT_RE.test(msg.text) || GOAL_ABOUT_RE.test(msg.text)) {
        goalReviewState.delete(chatId);
        sessionContexts.delete(chatId);
        await send(chatId, 'Starting the goal creation wizard...');
        await startGoalWizard(chatId);
        return;
      }

      // Otherwise, continue the review conversation
      const reply = await askClaude(chatId, msg.text);
      const changes = parseGoalChanges(reply);
      if (changes) {
        const result = applyGoalChanges(changes);
        console.log('[goals review] applied changes:', result);
        reindexInBackground();
      }
      await send(chatId, stripStructuredBlocks(reply));
      appendExchangeToLog(msg.text, stripStructuredBlocks(reply));
      return;
    }

    // Start a new goal wizard
    if (NL_NEW_GOAL_RE.test(msg.text)) {
      await startGoalWizard(chatId);
      return;
    }

    // Start LinkedIn post wizard
    if (NL_LINKEDIN_RE.test(msg.text)) {
      await startLinkedinWizard(chatId);
      return;
    }

    // Morning briefing
    if (NL_MORNING_RE.test(msg.text)) {
      await startMorningBriefing(chatId);
      return;
    }

    // Slides / presentation
    if (NL_SLIDES_RE.test(msg.text)) {
      const topic = msg.text.replace(NL_SLIDES_RE, '').trim() || msg.text;
      const result = await handleSlidesCreation(chatId, topic);
      if (result) appendExchangeToLog(`[NL] slides: ${result.topic}`, `Presentation: ${result.url}`);
      return;
    }

    // Super Team expert sessions
    if (NL_EXPERT_RE.test(msg.text)) {
      await startExpertSession(chatId, null);
      return;
    }
    if (NL_HORMOZI_RE.test(msg.text)) {
      await startExpertSession(chatId, msg.text);
      return;
    }
    if (NL_OGILVY_RE.test(msg.text)) {
      await startExpertSession(chatId, msg.text);
      return;
    }
    if (NL_GARYVEE_RE.test(msg.text)) {
      await startExpertSession(chatId, msg.text);
      return;
    }
    if (NL_BRUNSON_RE.test(msg.text)) {
      await startExpertSession(chatId, msg.text);
      return;
    }
    if (NL_SUBY_RE.test(msg.text)) {
      await startExpertSession(chatId, msg.text);
      return;
    }

    // Todoist: push goals → Todoist
    if (NL_TSYNC_RE.test(msg.text)) {
      await send(chatId, 'Syncing goals to Todoist...');
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const { stdout, stderr } = await execFileAsync('node', ['scripts/sync-goals-todoist.mjs'], { cwd: ROOT });
        const out = (stdout + stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
        await send(chatId, `*Todoist sync complete*\n\`\`\`\n${out}\n\`\`\``);
        appendExchangeToLog(msg.text, out);
      } catch (err) { await send(chatId, `Todoist sync error: ${err.message}`); }
      return;
    }

    // Todoist: pull completed tasks → goals.md
    if (NL_TPULL_RE.test(msg.text)) {
      await send(chatId, 'Pulling completed Todoist tasks into goals.md...');
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const { stdout, stderr } = await execFileAsync('node', ['scripts/pull-todoist-goals.mjs'], { cwd: ROOT });
        const out = (stdout + stderr).replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
        await send(chatId, `*Todoist pull complete*\n\`\`\`\n${out}\n\`\`\``);
        appendExchangeToLog(msg.text, out);
      } catch (err) { await send(chatId, `Todoist pull error: ${err.message}`); }
      return;
    }

    // Todoist: show open tasks
    if (NL_TTASKS_RE.test(msg.text)) {
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const context = await getTodoistContext();
        await send(chatId, context);
      } catch (err) { await send(chatId, `Todoist error: ${err.message}`); }
      return;
    }

    // Close/complete all tasks for a project (Freedcamp or Todoist)
    const tcloseMatch = msg.text.match(NL_TCLOSE_RE);
    if (tcloseMatch) {
      const isFc = /\b(freedcamp|fc)\b/i.test(msg.text);
      const rawName = tcloseMatch[1].replace(/[?!.,]+$/, '').replace(/\b(freedcamp|fc|todoist|in|en|de)\b/gi, '').trim();
      const projectName = rawName || tcloseMatch[1].replace(/[?!.,]+$/, '').trim();
      await bot.sendChatAction(chatId, 'typing').catch(() => { });

      if (isFc) {
        // Freedcamp close
        try {
          const projects = await getFcProjects();
          const project = projects.find(p => p.project_name.toLowerCase().includes(projectName.toLowerCase()));
          if (!project) {
            await send(chatId, `No Freedcamp project found matching "${projectName}". Use /fc to see projects.`);
            return;
          }
          const tasks = await getFcTasks(project.id);
          if (tasks.length === 0) {
            await send(chatId, `No open tasks in *${project.project_name}*.`);
            return;
          }
          await Promise.all(tasks.map(t => fcCompleteTask(t.id)));
          await send(chatId, `Completed ${tasks.length} task(s) in Freedcamp project *${project.project_name}*.`);
          appendExchangeToLog(msg.text, `Completed ${tasks.length} Freedcamp tasks in ${project.project_name}`);
        } catch (err) { await send(chatId, `Freedcamp error: ${err.message}`); }
      } else {
        // Todoist close (default)
        try {
          const projects = await getTdProjects();
          const project = projects.find(p => p.name.toLowerCase().includes(projectName.toLowerCase()));
          if (!project) {
            await send(chatId, `No Todoist project found matching "${projectName}". Use /ttasks to see projects.`);
            return;
          }
          const tasks = await getTasksForProject(project.id);
          if (tasks.length === 0) {
            await send(chatId, `No open tasks in *${project.name}*.`);
            return;
          }
          await Promise.all(tasks.map(t => closeTask(t.id)));
          await send(chatId, `Closed ${tasks.length} task(s) in *${project.name}*.`);
          appendExchangeToLog(msg.text, `Closed ${tasks.length} tasks in ${project.name}`);
        } catch (err) { await send(chatId, `Todoist error: ${err.message}`); }
      }
      return;
    }

    // Goal status
    if (NL_GSTATUS_RE.test(msg.text)) {
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const { stdout: s1 } = await execFileAsync('node', ['goals_manager.mjs', 'stats'], { cwd: ROOT });
        const { stdout: s2 } = await execFileAsync('node', ['goals_manager.mjs', 'list'], { cwd: ROOT });
        const stats = s1.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
        const list  = s2.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
        await send(chatId, `*Goal Status*\n\n${stats}\n\n${list}`);
      } catch (err) { await send(chatId, `Goal status error: ${err.message}`); }
      return;
    }

    // Goal diagram
    if (NL_GDIAGRAM_RE.test(msg.text)) {
      await send(chatId, 'Generating goals diagram...');
      await bot.sendChatAction(chatId, 'upload_document').catch(() => { });
      try {
        await execFileAsync('node', ['goals_manager.mjs', 'index'], { cwd: ROOT });
        await execFileAsync('node', ['scripts/generate-goals-diagram.mjs'], { cwd: ROOT });
        const diagramPath = join(ROOT, 'documents', 'goals-diagram.excalidraw');
        if (existsSync(diagramPath)) {
          await bot.sendDocument(chatId, diagramPath, {
            caption: 'Open at excalidraw.com: File → Open → select this file.\nBlue = active  |  Yellow = paused  |  Green = completed  |  Gray = archived',
          });
        } else {
          await send(chatId, 'Diagram file not found after generation.');
        }
      } catch (err) { await send(chatId, `Diagram error: ${err.message}`); }
      return;
    }

    // Gmail: show unread
    if (NL_GMAIL_RE.test(msg.text)) {
      if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const emails = await getUnread(10);
        if (emails.length === 0) { await send(chatId, 'No unread emails.'); return; }
        const lines = [`*Gmail — ${emails.length} unread*`, ''];
        emails.forEach((e, i) => {
          lines.push(`*${i + 1}.* ${e.subject}`);
          lines.push(`From: ${e.from}`);
          lines.push(`_${e.snippet.slice(0, 150)}_`);
          lines.push(`ID: \`${e.id}\``);
          lines.push('');
        });
        await send(chatId, lines.join('\n'));
      } catch (err) { await send(chatId, `Gmail error: ${err.message}`); }
      return;
    }

    // Gmail: smart search — any message mentioning email/gmail/correo + a query
    const gmailSearchMatch =
      msg.text.match(/\b(?:search|find|look\s+up|check|buscar|ver)\s+(?:(?:my|mis|an?|the|unread|recent)\s+)?(?:emails?|gmail|correos?|inbox|bandeja)\s+(?:for|about|from|mentioning|containing|with|sobre|de|que\s+mencione?|con)?\s*(.+)/i) ||
      msg.text.match(/\bemails?\s+(?:about|mentioning|containing|related\s+to|with|from|sobre|que\s+mencion[ae])\s+(.+)/i) ||
      msg.text.match(/\b(?:search|find|look)\s+for\s+emails?\s+(?:from|about|mentioning|of|with|de|sobre)?\s*(.+)/i) ||
      msg.text.match(/\b(?:buscar|encontrar)\s+(?:correos?|emails?)\s+(?:de|sobre|con|from|about)?\s*(.+)/i) ||
      msg.text.match(/\b(?:summarize|resumen?|summary of|resume)\s+(?:my\s+)?(?:emails?|gmail|correos?|inbox)\b/i) ||
      msg.text.match(/\b(?:my\s+)?(?:emails?|correos?)\s+(?:from|de)\s+(?:the\s+)?(?:last|past|los?\s+[uú]ltimos?)\s+\d+\s+(?:days?|d[ií]as?|hours?|horas?|weeks?|semanas?)\b/i);
    if (gmailSearchMatch) {
      if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        // Use Claude to build a proper Gmail search query from the natural language request
        const today = todayStr();
        const queryPrompt =
          `Convert this natural language email request into a Gmail search query.\n` +
          `Today is ${today}. Reply with ONLY the Gmail query string, nothing else.\n` +
          `Gmail query syntax: from:, to:, subject:, newer_than:3d, older_than:, is:unread, is:read, has:attachment, after:YYYY/MM/DD, before:YYYY/MM/DD\n` +
          `For "last 3 days" use newer_than:3d. For "unanswered" or "haven't responded" use -in:sent (exclude sent).\n` +
          `For "people sent to me" use in:inbox.\n\n` +
          `Request: ${msg.text}`;
        const gmailQuery = (await askClaude(chatId, queryPrompt)).replace(/[`"']/g, '').trim();
        console.log('[gmail] NL query →', gmailQuery);

        const emails = await searchEmails(gmailQuery, 15);
        if (emails.length === 0) { await send(chatId, `No emails found (query: \`${gmailQuery}\`)`); return; }

        // Format emails and ask Claude to summarize per the user's original request
        const emailList = emails.map((e, i) =>
          `${i + 1}. Subject: ${e.subject}\n   From: ${e.from}\n   Date: ${e.date?.slice(0, 16) ?? ''}\n   Preview: ${e.snippet.slice(0, 200)}`
        ).join('\n\n');

        const summarizePrompt =
          `The user asked: "${msg.text}"\n\n` +
          `Here are the ${emails.length} matching emails:\n\n${emailList}\n\n` +
          `Provide a concise summary responding to what the user asked. ` +
          `Use Telegram markdown (*bold*, _italic_). Be brief and direct.`;

        // Fresh history for summary — don't pollute main conversation
        histories.delete(chatId);
        const summary = await askClaude(chatId, summarizePrompt);
        await send(chatId, stripStructuredBlocks(summary));
        appendExchangeToLog(msg.text, stripStructuredBlocks(summary));
      } catch (err) { await send(chatId, `Gmail error: ${err.message}`); }
      return;
    }

    // Gmail: "emails from Viviana" / "received any emails from X"
    const gmailFromMatch = msg.text.match(NL_GMAIL_FROM_RE);
    if (gmailFromMatch) {
      const person = gmailFromMatch[2].replace(/[?!.,]+$/, '').trim();
      const query = `from:${person}`;
      if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const emails = await searchEmails(query, 10);
        if (emails.length === 0) { await send(chatId, `No emails found from _${person}_.`); return; }
        const lines = [`*Gmail — emails from ${person} (${emails.length})*`, ''];
        emails.forEach((e, i) => {
          lines.push(`*${i + 1}.* ${e.subject}`);
          lines.push(`${e.date?.slice(0, 16) ?? ''}`);
          lines.push(`_${e.snippet.slice(0, 150)}_`);
          lines.push(`ID: \`${e.id}\``);
          lines.push('');
        });
        await send(chatId, lines.join('\n'));
      } catch (err) { await send(chatId, `Gmail error: ${err.message}`); }
      return;
    }

    // Gmail: "send email to X saying Y"
    // Gmail send:
    //   p1: "send email to X saying Y"
    //   p2: "send email to X subject Y body Z"  (comma optional between subject/body)
    //   p3: /gsend shorthand parsed inline
    const _emailTo = msg.text.match(/\b(?:(?:send|write|draft|enviar|mandar)\s+(?:an?\s+)?)?(?:email|mail|correo|mensaje)\s+(?:to|a|para)\s+(\S+@\S+)/i);
    let gmailSendMatch = null;
    if (_emailTo) {
      const rest = msg.text.slice(_emailTo.index + _emailTo[0].length).trim();
      // Try "subject ... body ..." with optional comma/colon separators
      const withSubject = rest.match(/^[,.]?\s*(?:subject|asunto|tema)[:\s]+(.+?)\s*[,.]?\s*(?:body|message|texto|cuerpo|mensaje)[:\s]+([\s\S]+)/i);
      // Try "saying/with ..."
      const withSaying  = rest.match(/^[,.]?\s*(?:saying|with|that says|telling|diciendo|con)\s+([\s\S]+)/i);
      if (withSubject) {
        gmailSendMatch = { to: _emailTo[1], subject: withSubject[1].trim(), body: withSubject[2].trim() };
      } else if (withSaying) {
        gmailSendMatch = { to: _emailTo[1], subject: 'Mensaje', body: withSaying[1].trim() };
      }
    }

    if (gmailSendMatch) {
      const { to, subject, body: rawBody } = gmailSendMatch;
      const body = rawBody.replace(/[?!]+$/, '').trim();
      if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        await sendEmail(to, subject, body);
        await send(chatId, `Email sent to ${to}.`);
        appendExchangeToLog(`send email to ${to}`, 'Email sent.');
      } catch (err) { await send(chatId, `Send error: ${err.message}`); }
      return;
    }

    // Drive: list recent files
    if (NL_DRIVE_RE.test(msg.text)) {
      if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const files = await listRecent(10);
        if (files.length === 0) { await send(chatId, 'No files found in Drive.'); return; }
        const lines = [`*Google Drive — ${files.length} recent files*`, ''];
        files.forEach((f, i) => {
          const type     = f.mimeType.split('.').pop().replace('google-apps.', '');
          const modified = f.modifiedTime?.slice(0, 10) ?? '';
          lines.push(`*${i + 1}.* ${f.name}`);
          lines.push(`Type: ${type}  |  Modified: ${modified}  |  ID: \`${f.id}\``);
          lines.push('');
        });
        await send(chatId, lines.join('\n'));
      } catch (err) { await send(chatId, `Drive error: ${err.message}`); }
      return;
    }

    // Drive: search — "search drive for X" / "find file X"
    const driveSearchMatch = msg.text.match(/\b(?:search (?:my )?drive(?: for)?|find (?:a |the )?file(?: in drive)?(?:(?: called| named))?|buscar (?:en )?drive|buscar archivo)\s+(.+)/i);
    if (driveSearchMatch) {
      const query = driveSearchMatch[1]?.trim() || driveSearchMatch[2]?.trim();
      if (query && !isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      if (query) {
        await bot.sendChatAction(chatId, 'typing').catch(() => { });
        try {
          const files = await searchFiles(query, 10);
          if (files.length === 0) { await send(chatId, `No Drive files found for: _${query}_`); return; }
          const lines = [`*Drive search: "${query}" — ${files.length} results*`, ''];
          files.forEach((f, i) => {
            const type     = f.mimeType.split('.').pop().replace('google-apps.', '');
            const modified = f.modifiedTime?.slice(0, 10) ?? '';
            lines.push(`*${i + 1}.* ${f.name}`);
            lines.push(`Type: ${type}  |  Modified: ${modified}  |  ID: \`${f.id}\``);
            lines.push('');
          });
          await send(chatId, lines.join('\n'));
        } catch (err) { await send(chatId, `Drive search error: ${err.message}`); }
        return;
      }
    }

    // Calendar: show upcoming / today
    if (NL_CALENDAR_RE.test(msg.text)) {
      if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const isToday = /\b(today|hoy)\b/i.test(msg.text);
        const events = isToday ? await getTodayEvents() : await getUpcomingEvents(10);
        if (events.length === 0) {
          await send(chatId, isToday ? 'No events today.' : 'No upcoming events.');
          return;
        }
        const label = isToday ? `Today's events (${events.length})` : `Calendar — ${events.length} upcoming events`;
        const lines = [`*${label}*`, ''];
        events.forEach((e, i) => {
          lines.push(`*${i + 1}.* ${e.title}`);
          lines.push(`${e.start} → ${e.end}`);
          if (e.location) lines.push(`Location: ${e.location}`);
          lines.push(`ID: \`${e.id}\``);
          lines.push('');
        });
        await send(chatId, lines.join('\n'));
      } catch (err) { await send(chatId, `Calendar error: ${err.message}`); }
      return;
    }

    // Calendar: search — "search calendar for X" / "find event about X"
    const calSearchMatch = msg.text.match(/\b(?:search (?:my )?calendar(?: for)?|find (?:a |the )?event(?: about| for)?|buscar (?:en )?calendario|buscar evento)\s+(.+)/i);
    if (calSearchMatch) {
      const query = calSearchMatch[1].trim();
      if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const events = await searchCalEvents(query, 10);
        if (events.length === 0) { await send(chatId, `No calendar events found for: _${query}_`); return; }
        const lines = [`*Calendar search: "${query}" — ${events.length} results*`, ''];
        events.forEach((e, i) => {
          lines.push(`*${i + 1}.* ${e.title}`);
          lines.push(`${e.start} → ${e.end}`);
          if (e.location) lines.push(`Location: ${e.location}`);
          lines.push(`ID: \`${e.id}\``);
          lines.push('');
        });
        await send(chatId, lines.join('\n'));
      } catch (err) { await send(chatId, `Calendar search error: ${err.message}`); }
      return;
    }

    // Calendar: NL create — "schedule a meeting tomorrow at 3pm"
    if (NL_CALENDAR_CREATE_RE.test(msg.text)) {
      if (!isGoogleAuthorised()) { await send(chatId, 'Google not authorised. Run /gauth first.'); return; }
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const today = todayStr();
        const dayOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][nowInTz().getDay()];
        const extractPrompt =
          `Extract calendar event details from this request. Today is ${dayOfWeek}, ${today}. Timezone: America/Santiago (Chile, UTC-3).\n` +
          `Reply with ONLY a JSON object (no markdown, no explanation):\n` +
          `{ "title": "...", "start": "ISO 8601 datetime", "end": "ISO 8601 datetime", "description": "...", "location": "...", "attendees": ["email@example.com"] }\n` +
          `If no end time given, assume 1 hour after start.\n` +
          `If no specific time given, use 09:00.\n` +
          `For relative dates ("tomorrow", "next Saturday"), calculate the actual date.\n` +
          `"attendees" is an array of email addresses. If no emails mentioned, use [].\n\n` +
          `Request: ${msg.text}`;
        const raw = await askClaude(chatId, extractPrompt);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          await send(chatId, 'Could not parse event details. Use `/gccreate <title> | <start> | <end>` instead.');
          return;
        }
        const parsed = JSON.parse(jsonMatch[0]);
        const attendees = Array.isArray(parsed.attendees) ? parsed.attendees.filter(e => e.includes('@')) : [];
        const result = await createEvent(
          parsed.title, parsed.start, parsed.end,
          parsed.description || '', parsed.location || '', attendees
        );
        const lines = [
          `Event created: *${parsed.title}*`,
          `${parsed.start.slice(0, 16).replace('T', ' ')} → ${parsed.end.slice(0, 16).replace('T', ' ')}`,
        ];
        if (attendees.length > 0) lines.push(`Invitation sent to: ${attendees.join(', ')}`);
        lines.push(`ID: \`${result.id}\``, result.link);
        await send(chatId, lines.join('\n'));
        appendExchangeToLog(msg.text, `Created calendar event "${parsed.title}" ${result.id}${attendees.length ? ` — invited: ${attendees.join(', ')}` : ''}`);
      } catch (err) { await send(chatId, `Calendar create error: ${err.message}`); }
      return;
    }

    // ─── LinkedIn post clip (oEmbed + og:description fallback) ─────────────
    const clipTarget = detectUrl(msg.text);
    if (clipTarget && isLinkedInUrl(clipTarget)) {
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const { title, authorName, localPath, wordCount } = await clipLinkedIn(clipTarget);
        await send(chatId,
          `*LinkedIn post saved*\n\n` +
          `*Author:* ${authorName}\n` +
          `*Title:* ${title}\n` +
          `*Words:* ${wordCount.toLocaleString()}\n` +
          `*File:* \`${localPath}\``
        );
        appendExchangeToLog(msg.text, `LinkedIn clip: ${title} by ${authorName} → ${localPath}`);
        reindexInBackground();
      } catch (err) {
        await send(chatId, `LinkedIn clip error: ${err.message}`);
      }
      return;
    }

    // ─── URL clip → extract content → save locally + Evernote ────────────────
    if (clipTarget) {
      await bot.sendChatAction(chatId, 'typing').catch(() => { });
      try {
        const { title, localPath, evernoteGuid, wordCount } = await clipUrl(clipTarget);
        await send(chatId,
          `*Clipped:* ${title}\n\n` +
          `*Words extracted:* ${wordCount.toLocaleString()}\n` +
          `*Local file:* \`${localPath}\``
        );
        appendExchangeToLog(msg.text, `Clipped: ${title} → ${localPath}`);
        reindexInBackground();
      } catch (err) {
        await send(chatId, `Clip error: ${err.message}`);
      }
      return;
    }

    // Keyword-triggered document creation (create a doc about / write a note on / etc.)
    const docTopic = detectDocRequest(msg.text);
    if (docTopic) {
      const result = await handleDocCreation(chatId, docTopic);
      if (result) appendExchangeToLog(msg.text, `Document saved: ${result.filePath}`);
      return;
    }

    // Keyword-triggered web search (look up / research / busca / etc.)
    const webQuery = detectWebSearch(msg.text);
    if (webQuery) {
      const result = await handleWebSearch(chatId, webQuery);
      if (result) appendExchangeToLog(msg.text, result.reply);
      return;
    }

    // Keyword-triggered Freedcamp context injection (tasks, projects, deadlines, etc.)
    if (detectFreedcampQuery(msg.text)) {
      const reply = await handleFreedcampQuery(chatId, msg.text);
      if (reply) appendExchangeToLog(msg.text, stripStructuredBlocks(reply));
      return;
    }

    const reply = await askClaude(chatId, msg.text);
    await send(chatId, stripStructuredBlocks(reply));

    appendExchangeToLog(msg.text, stripStructuredBlocks(reply));
    reindexInBackground();

  } catch (err) {
    console.error('[claude error]', err.message);
    await send(chatId, `Error: ${err.message}`);
  } finally {
    processing.delete(chatId);
  }
});

// ─── Error handling ───────────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
  if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
    // Another instance is still holding the connection — Telegram resolves this
    // automatically within ~30 seconds. Log and wait; do NOT exit (exiting causes
    // PM2 to restart immediately, creating an infinite 409 loop).
    console.warn('[warn] 409 conflict — another instance still connected, waiting for Telegram to release...');
    return;
  }
  console.error('[polling error]', err.message);
});

// ─── Startup ──────────────────────────────────────────────────────────────────

if (bot) {
  const modelName = process.env.CLAUDE_MODEL || CLAUDE_MODEL;
  const authUser = process.env.ALLOWED_TELEGRAM_USER_ID || ALLOWED_TELEGRAM_USER_ID;
  console.log('Second brain bot starting...');
  console.log(`Model : ${modelName}`);
  console.log(`Root  : ${ROOT}`);
  console.log(`Auth  : ${authUser ? `user ${authUser} only` : 'open (no ALLOWED_TELEGRAM_USER_ID set)'}`);
  console.log('Ready. Listening for messages...');
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

const dashboard = startDashboard({
  port: DASHBOARD_PORT,
  rootDir: ROOT,
  getUpcomingEvents,
  services: {
    getTodoistTasks: async () => {
      const projects = await getTdProjects();
      const result = [];
      for (const p of projects) {
        const tasks = await getTasksForProject(p.id);
        if (tasks.length > 0) result.push({ project: p.name, tasks });
      }
      return result;
    },
    getFreedcampTasks: async () => {
      const { getAllTasks: fcGetAll } = await import('./freedcamp.mjs');
      const groups = await fcGetAll();
      // Filter: keep only tasks where f_completed is falsy or exactly 0/"0"
      return groups.map(g => ({
        project: { project_name: g.project.project_name, id: g.project.id },
        tasks: g.tasks.filter(t => !t.f_completed || t.f_completed === 0 || t.f_completed === '0'),
      })).filter(g => g.tasks.length > 0);
    },
    getRecentEmails: async () => searchEmails('newer_than:7d', 20),
  },
});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

const heartbeat = startHeartbeat(bot, {
  allowedUserId: process.env.ALLOWED_TELEGRAM_USER_ID || ALLOWED_TELEGRAM_USER_ID,
  intervalMs: 180 * 60 * 1000,   // 180 minutes
});

// ─── Scheduler ─────────────────────────────────────────────────────────────────

let currentScheduler = null;

function restartScheduler() {
  currentScheduler?.stop();
  const schedules = parseScheduleConfig();
  currentScheduler = Object.keys(schedules).length > 0
    ? startScheduler(bot, {
        allowedUserId: process.env.ALLOWED_TELEGRAM_USER_ID || ALLOWED_TELEGRAM_USER_ID,
        schedules,
      })
    : null;
  return schedules;
}

restartScheduler();

process.on('SIGINT', () => { console.log('\nShutting down.'); heartbeat.stop(); currentScheduler?.stop(); bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', () => { heartbeat.stop(); currentScheduler?.stop(); bot.stopPolling(); process.exit(0); });
