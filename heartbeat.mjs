/**
 * heartbeat.mjs — Periodic proactive notification check.
 *
 * Every INTERVAL_MS (default 180 min):
 *   1. Read memory files + today's log
 *   2. Ask Claude if anything is worth notifying the user about
 *   3. If Claude replies HEARTBEAT_OK → skip silently
 *   4. If duplicate of last notification within 24h → skip
 *   5. Otherwise → send Telegram message
 *   6. Log every decision to heartbeat_debug.log
 *   7. Persist last-sent state to heartbeat_log.json
 *
 * Usage (from bot.mjs):
 *   import { startHeartbeat } from './heartbeat.mjs';
 *   const hb = startHeartbeat(bot, { allowedUserId, intervalMs });
 *   // hb.stop() to shut down cleanly
 */

import { spawn } from 'node:child_process';
import {
  readFileSync, existsSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────────

const ROOT        = resolve('.');
const MEMORY_DIR  = join(ROOT, 'memory');
const LOG_FILE    = join(ROOT, 'heartbeat_debug.log');
const STATE_FILE  = join(ROOT, 'heartbeat_log.json');
const SKIP_TOKEN  = 'HEARTBEAT_OK';
const DEDUP_MS    = 24 * 60 * 60 * 1000; // 24 hours

const { CLAUDE_MODEL = 'opus' } = process.env;

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write('[heartbeat] ' + line);
  try { appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* ignore write errors */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readSafe(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

function loadState() {
  try {
    return existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      : {};
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(patch, null, 2), 'utf8');
  } catch (err) {
    log(`ERROR saving state: ${err.message}`);
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt() {
  const today    = new Date().toISOString().slice(0, 10);
  const soul     = readSafe(join(ROOT, 'soul.md'));
  const user     = readSafe(join(ROOT, 'user.md'));
  const memory   = readSafe(join(ROOT, 'memory.md'));
  const todayLog = readSafe(join(MEMORY_DIR, `${today}.md`));

  const sections = [
    soul     && `# soul.md\n\n${soul}`,
    user     && `# user.md\n\n${user}`,
    memory   && `# memory.md\n\n${memory}`,
    todayLog && `# memory/${today}.md (today's log)\n\n${todayLog}`,
  ].filter(Boolean).join('\n\n---\n\n');

  return [
    '<memory_context>',
    sections || '(No memory files found.)',
    '</memory_context>',
    '',
    `Current time: ${new Date().toISOString()}`,
    '',
    'You are running a scheduled heartbeat check for the user.',
    'Review everything in the memory context above.',
    '',
    `Reply with exactly "${SKIP_TOKEN}" (nothing else) if there is nothing actionable right now.`,
    '',
    'Send a notification ONLY if you find something clearly worth interrupting the user for:',
    '  - A deadline, time-sensitive task, or overdue commitment mentioned in the logs',
    '  - An open loop they said they would close but have not (based on today\'s log)',
    '  - A decision that was deferred and the deferral period has likely passed',
    '  - Something in their projects that looks stalled and needs a nudge',
    '',
    'If you do send a notification, write 2-4 lines maximum. Be specific — name the task,',
    'deadline, or decision. No filler. No "Just a reminder that...". Start with the point.',
    '',
    `Skip token: ${SKIP_TOKEN}`,
  ].join('\n');
}

// ─── Claude subprocess ────────────────────────────────────────────────────────

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE;
    delete env.CLAUDECODE;

    const proc = spawn('claude', [
      '--print',
      '--model',  CLAUDE_MODEL,
      '--no-session-persistence',
      '--tools',  '',
      '--output-format', 'text',
    ], {
      env,
      cwd:   ROOT,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error('claude CLI not found'));
      else reject(err);
    });

    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();
  });
}

// ─── Single heartbeat tick ────────────────────────────────────────────────────

async function tick(bot, allowedUserId, tickNum) {
  const now = Date.now();
  log(`Tick #${tickNum} started`);

  // Call Claude
  let response;
  try {
    response = await callClaude(buildPrompt());
    const preview = response.slice(0, 100).replace(/\n/g, ' ');
    log(`Claude: "${preview}${response.length > 100 ? '...' : ''}"`);
  } catch (err) {
    log(`ERROR calling Claude: ${err.message}`);
    log('Tick #' + tickNum + ' aborted — will retry next interval');
    return;
  }

  const normalized = response.trim();

  // Skip token check (OpenClaw pattern)
  if (normalized === SKIP_TOKEN || normalized.startsWith(SKIP_TOKEN + '\n')) {
    log(`Status: skipped (ok-token) — nothing to notify`);
    return;
  }

  // 24h deduplication (OpenClaw pattern)
  const state = loadState();
  if (
    state.lastSentText &&
    state.lastSentText.trim() === normalized &&
    typeof state.lastSentAt === 'number' &&
    now - state.lastSentAt < DEDUP_MS
  ) {
    const hoursAgo = ((now - state.lastSentAt) / 3_600_000).toFixed(1);
    log(`Status: skipped (duplicate — identical message sent ${hoursAgo}h ago)`);
    return;
  }

  // Guard: need a user to notify
  if (!allowedUserId) {
    log('ERROR: ALLOWED_TELEGRAM_USER_ID not set — cannot send heartbeat notification');
    return;
  }

  // Send Telegram message
  try {
    await bot
      .sendMessage(allowedUserId, `*Heartbeat*\n\n${normalized}`, { parse_mode: 'Markdown' })
      .catch(() => bot.sendMessage(allowedUserId, `Heartbeat\n\n${normalized}`));

    log(`Status: sent to user ${allowedUserId}`);
    log(`Content: ${normalized.slice(0, 200).replace(/\n/g, ' ')}`);

    saveState({
      lastSentText:     normalized,
      lastSentAt:       now,
      lastSentReadable: new Date(now).toISOString(),
      tickNum,
    });
  } catch (err) {
    log(`ERROR sending Telegram message: ${err.message}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the heartbeat loop.
 *
 * @param {object} bot           - node-telegram-bot-api instance
 * @param {object} opts
 * @param {string} opts.allowedUserId  - Telegram user ID to notify
 * @param {number} opts.intervalMs     - Interval between ticks (default 180 min)
 * @returns {{ stop: () => void }}
 */
export function startHeartbeat(bot, {
  allowedUserId,
  intervalMs = 180 * 60 * 1000,
} = {}) {
  let tickNum  = 0;
  let timer    = null;
  let stopped  = false;

  const intervalMin = Math.round(intervalMs / 60_000);
  log(`Started — interval: ${intervalMin} min, user: ${allowedUserId ?? '(none set)'}`);

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      tickNum++;
      try {
        await tick(bot, allowedUserId, tickNum);
      } catch (err) {
        log(`UNHANDLED error in tick: ${err.message}`);
      }
      log(`Next tick in ${intervalMin} minutes`);
      schedule();
    }, intervalMs);
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
