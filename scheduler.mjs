/**
 * scheduler.mjs — Deterministic time-based scheduler.
 *
 * Checks every 60 seconds whether a scheduled event should fire.
 * Persists last-fired timestamps to scheduler_state.json to avoid
 * re-triggering after restarts.
 *
 * Schedules:
 *   - morning_briefing: daily at SCHEDULE_MORNING (e.g. "08:30")
 *   - weekly_summary:   weekly at SCHEDULE_WEEKLY (e.g. "FRI:16:00")
 *
 * Usage (from bot.mjs):
 *   import { startScheduler, parseScheduleConfig } from './scheduler.mjs';
 *   const schedules = parseScheduleConfig();
 *   const sched = startScheduler(bot, { allowedUserId, schedules });
 *   // sched.stop() to shut down cleanly
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readFileSync, existsSync, writeFileSync, appendFileSync, readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

const ROOT             = resolve('.');
const MEMORY_DIR       = join(ROOT, 'memory');
const STATE_FILE       = join(ROOT, 'scheduler_state.json');
const LOG_FILE         = join(ROOT, 'scheduler_debug.log');
const CHECK_INTERVAL   = 60_000; // 60 seconds

const { CLAUDE_MODEL = 'opus' } = process.env;

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write('[scheduler] ' + line);
  try { appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* ignore */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tz() {
  return process.env.TIMEZONE || process.env.CALENDAR_TIMEZONE || 'America/Santiago';
}

function nowInTz() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz() }));
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz() });
}

function readSafe(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : null;
  } catch { return null; }
}

function loadState() {
  try {
    return existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      : {};
  } catch { return {}; }
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log(`ERROR saving state: ${err.message}`);
  }
}

function stripWarnings(text) {
  return text.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n/g, '').trim();
}

// ─── Claude subprocess ────────────────────────────────────────────────────────

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE;
    delete env.CLAUDECODE;

    const proc = spawn('claude', [
      '--print', '--model', CLAUDE_MODEL,
      '--no-session-persistence', '--tools', '',
      '--output-format', 'text',
    ], {
      env, cwd: ROOT,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude timed out (120s)'));
    }, 120_000);

    proc.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
    proc.on('error', err => {
      clearTimeout(timeout);
      if (err.code === 'ENOENT') reject(new Error('claude CLI not found'));
      else reject(err);
    });

    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();
  });
}

// ─── Google module safe wrappers ──────────────────────────────────────────────

async function getTodayEventsSafe() {
  try {
    const { isAuthorised } = await import('./google-auth.mjs');
    if (!isAuthorised()) return 'Google not authorised — no calendar data.';
    const { getTodayEvents } = await import('./calendar.mjs');
    const events = await getTodayEvents();
    if (events.length === 0) return 'No events today.';
    return events.map((e, i) =>
      `${i + 1}. ${e.title} — ${e.start}${e.location ? ' @ ' + e.location : ''}`
    ).join('\n');
  } catch (err) {
    return `Calendar error: ${err.message}`;
  }
}

async function getEmailContextSafe() {
  try {
    const { isAuthorised } = await import('./google-auth.mjs');
    if (!isAuthorised()) return 'Google not authorised — no email data.';
    const { getEmailContext } = await import('./gmail.mjs');
    return getEmailContext(5);
  } catch (err) {
    return `Gmail error: ${err.message}`;
  }
}

// ─── Time matching ────────────────────────────────────────────────────────────

/**
 * Check if current local time matches a schedule.
 * @param {string} scheduleId
 * @param {{ type: string, hour: number, minute: number, dayOfWeek?: number }} schedule
 * @param {object} state - last-fired state
 * @returns {boolean}
 */
function shouldFire(scheduleId, schedule, state) {
  const now   = nowInTz();
  const today = todayStr();

  // Day-of-week filter (for weekly schedules)
  if (schedule.dayOfWeek !== undefined && now.getDay() !== schedule.dayOfWeek) {
    return false;
  }

  const targetMinutes  = schedule.hour * 60 + schedule.minute;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  // Must be within 1 minute of target time
  if (Math.abs(currentMinutes - targetMinutes) > 1) {
    return false;
  }

  // Already fired today?
  if (state[scheduleId] === today) {
    return false;
  }

  return true;
}

// ─── Briefing generators ──────────────────────────────────────────────────────

async function generateMorningBriefing() {
  log('Generating morning briefing...');

  const [freedcampResult, todoistResult, calendarResult, goalsResult, gmailResult] =
    await Promise.allSettled([
      execFileAsync('node', ['scripts/fetch-freedcamp.mjs'], { cwd: ROOT })
        .then(({ stdout, stderr }) => stripWarnings(stdout + stderr)),
      execFileAsync('node', ['todoist.mjs', 'tasks'], { cwd: ROOT })
        .then(({ stdout, stderr }) => stripWarnings(stdout + stderr))
        .catch(() => ''),
      getTodayEventsSafe(),
      execFileAsync('node', ['goals_manager.mjs', 'list', '--status=active'], { cwd: ROOT })
        .then(({ stdout, stderr }) => stripWarnings(stdout + stderr))
        .catch(() => ''),
      getEmailContextSafe(),
    ]);

  const freedcamp = freedcampResult.status === 'fulfilled' ? freedcampResult.value : 'Freedcamp unavailable.';
  const todoist   = todoistResult.status === 'fulfilled'   ? todoistResult.value   : 'Todoist unavailable.';
  const calendar  = calendarResult.status === 'fulfilled'  ? calendarResult.value  : 'Calendar unavailable.';
  const goals     = goalsResult.status === 'fulfilled'     ? goalsResult.value     : 'Goals unavailable.';
  const gmail     = gmailResult.status === 'fulfilled'     ? gmailResult.value     : 'Gmail unavailable.';

  // Memory context
  const soul     = readSafe(join(ROOT, 'soul.md'));
  const user     = readSafe(join(ROOT, 'user.md'));
  const memory   = readSafe(join(ROOT, 'memory.md'));
  const todayLog = readSafe(join(MEMORY_DIR, `${todayStr()}.md`));

  const memoryContext = [
    soul     && `# soul.md\n\n${soul}`,
    user     && `# user.md\n\n${user}`,
    memory   && `# memory.md\n\n${memory}`,
    todayLog && `# memory/${todayStr()}.md\n\n${todayLog}`,
  ].filter(Boolean).join('\n\n---\n\n');

  const dataContext = [
    '# Current Freedcamp Tasks', '', freedcamp, '',
    '# Todoist Tasks (open)', '', todoist || '(none)', '',
    '# Calendar — Today', '', calendar, '',
    '# Active Goals', '', goals || '(none)', '',
    '# Gmail — Unread Emails', '', gmail,
  ].join('\n');

  const prompt = [
    '<memory_context>',
    memoryContext || '(No memory files found.)',
    '</memory_context>',
    '',
    '<data_context>',
    dataContext,
    '</data_context>',
    '',
    `Current time: ${new Date().toISOString()}`,
    '',
    'Generate a morning briefing for the user. You have their Freedcamp tasks, Todoist tasks,',
    "today's calendar events, active goals, and unread emails above.",
    '',
    'Write a concise morning overview covering:',
    '- Key tasks and priorities for today',
    '- Any calendar events or meetings',
    '- Important unread emails worth noting',
    '- Goal progress snapshot',
    '',
    'Keep it to 10-15 lines max. Be specific — name actual tasks, meetings, and emails.',
    'Write in Spanish. Start directly with the content. No greetings or openers.',
  ].join('\n');

  return callClaude(prompt);
}

async function generateWeeklySummary() {
  log('Generating weekly summary...');

  // Collect daily logs from the past 7 days
  const dailyLogs = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: tz() });
    const content = readSafe(join(MEMORY_DIR, `${dateStr}.md`));
    if (content) {
      dailyLogs.push(`## ${dateStr}\n\n${content}`);
    }
  }

  const [goalsResult, todoistResult] = await Promise.allSettled([
    execFileAsync('node', ['goals_manager.mjs', 'list'], { cwd: ROOT })
      .then(({ stdout, stderr }) => stripWarnings(stdout + stderr))
      .catch(() => ''),
    execFileAsync('node', ['todoist.mjs', 'tasks'], { cwd: ROOT })
      .then(({ stdout, stderr }) => stripWarnings(stdout + stderr))
      .catch(() => ''),
  ]);

  const goals   = goalsResult.status === 'fulfilled'  ? goalsResult.value  : '';
  const todoist = todoistResult.status === 'fulfilled' ? todoistResult.value : '';

  const soul   = readSafe(join(ROOT, 'soul.md'));
  const user   = readSafe(join(ROOT, 'user.md'));
  const memory = readSafe(join(ROOT, 'memory.md'));

  const memoryContext = [
    soul   && `# soul.md\n\n${soul}`,
    user   && `# user.md\n\n${user}`,
    memory && `# memory.md\n\n${memory}`,
  ].filter(Boolean).join('\n\n---\n\n');

  const prompt = [
    '<memory_context>',
    memoryContext || '(No memory files found.)',
    '</memory_context>',
    '',
    '<weekly_data>',
    '# Daily Logs (past 7 days)',
    '',
    dailyLogs.length > 0 ? dailyLogs.join('\n\n---\n\n') : '(No daily logs found for this week.)',
    '',
    '# Current Goals',
    '',
    goals || '(none)',
    '',
    '# Open Todoist Tasks',
    '',
    todoist || '(none)',
    '</weekly_data>',
    '',
    `Current time: ${new Date().toISOString()}`,
    '',
    'Generate a weekly summary for the user. Review their daily logs from the past 7 days,',
    'current goals, and remaining tasks.',
    '',
    'Structure the summary as:',
    '1. **Esta semana** — What got done, key accomplishments (2-4 bullet points)',
    '2. **Que se estanco** — Tasks or goals that did not move forward',
    '3. **Patrones** — Any recurring themes (productivity, blockers, context-switching)',
    '4. **Foco para la proxima semana** — 2-3 specific priorities based on what you see',
    '',
    'Keep it honest and direct. Max 20 lines. Name specific tasks and goals.',
    'Write in Spanish.',
  ].join('\n');

  return callClaude(prompt);
}

// ─── Send to Telegram ─────────────────────────────────────────────────────────

async function sendToUser(bot, userId, label, text) {
  if (!userId) {
    log('ERROR: No userId — cannot send scheduled message');
    return;
  }

  const fullText = `*${label}*\n\n${text}`;
  const TG_LIMIT = 4096;

  if (fullText.length <= TG_LIMIT) {
    await bot.sendMessage(userId, fullText, { parse_mode: 'Markdown' })
      .catch(() => bot.sendMessage(userId, fullText));
    return;
  }

  // Split long messages
  let remaining = fullText;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, TG_LIMIT);
    remaining = remaining.slice(TG_LIMIT);
    await bot.sendMessage(userId, chunk, { parse_mode: 'Markdown' })
      .catch(() => bot.sendMessage(userId, chunk));
  }
}

// ─── Log to memory ────────────────────────────────────────────────────────────

function appendToLog(text) {
  execFileAsync('node', ['memory_manager.mjs', 'log', text], { cwd: ROOT }).catch(() => {});
}

// ─── Tick loop ────────────────────────────────────────────────────────────────

async function tick(bot, allowedUserId, schedules) {
  const state = loadState();

  for (const [id, schedule] of Object.entries(schedules)) {
    if (!shouldFire(id, schedule, state)) continue;

    log(`Schedule "${id}" triggered`);

    try {
      let text;
      if (schedule.type === 'morning') {
        text = await generateMorningBriefing();
        await sendToUser(bot, allowedUserId, 'Morning Briefing', text);
        appendToLog(`[Auto] Morning briefing sent`);
      } else if (schedule.type === 'weekly') {
        text = await generateWeeklySummary();
        await sendToUser(bot, allowedUserId, 'Resumen Semanal', text);
        appendToLog(`[Auto] Weekly summary sent`);
      }

      state[id] = todayStr();
      saveState(state);
      log(`Schedule "${id}" completed successfully`);
    } catch (err) {
      log(`ERROR in schedule "${id}": ${err.message}`);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse schedule config from environment variables.
 *
 * SCHEDULE_MORNING=08:30        → daily at 8:30 AM local
 * SCHEDULE_WEEKLY=FRI:16:00     → Friday at 4:00 PM local
 */
export function parseScheduleConfig() {
  const schedules = {};

  const morningTime = process.env.SCHEDULE_MORNING;
  if (morningTime) {
    const [h, m] = morningTime.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m)) {
      schedules.morning_briefing = { type: 'morning', hour: h, minute: m };
    }
  }

  const weeklyTime = process.env.SCHEDULE_WEEKLY;
  if (weeklyTime) {
    const DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
    const parts = weeklyTime.split(':');
    if (parts.length === 3) {
      const day = DAYS[parts[0].toUpperCase()];
      const h = Number(parts[1]);
      const m = Number(parts[2]);
      if (day !== undefined && !isNaN(h) && !isNaN(m)) {
        schedules.weekly_summary = { type: 'weekly', hour: h, minute: m, dayOfWeek: day };
      }
    }
  }

  return schedules;
}

/**
 * Start the scheduler loop.
 *
 * @param {object} bot - node-telegram-bot-api instance
 * @param {object} opts
 * @param {string} opts.allowedUserId - Telegram user ID to send to
 * @param {object} opts.schedules - Map of schedule definitions
 * @returns {{ stop: () => void }}
 */
export function startScheduler(bot, { allowedUserId, schedules = {} } = {}) {
  let timer   = null;
  let stopped = false;

  const count = Object.keys(schedules).length;
  log(`Started — ${count} schedule(s) configured, user: ${allowedUserId ?? '(none)'}`);
  for (const [id, s] of Object.entries(schedules)) {
    log(`  ${id}: ${s.type} at ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}` +
        (s.dayOfWeek !== undefined ? ` (day ${s.dayOfWeek})` : ' (daily)'));
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await tick(bot, allowedUserId, schedules);
      } catch (err) {
        log(`UNHANDLED error in tick: ${err.message}`);
      }
      schedule();
    }, CHECK_INTERVAL);
  }

  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      log('Stopped');
    },
  };
}
