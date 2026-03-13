#!/usr/bin/env node
/**
 * generate-figjam-data.mjs
 *
 * Reads documents/goals-*.md and documents/offer.md,
 * parses the goal/plan structure, and writes figjam-plugin/ui.html
 * with the data embedded — ready to load in FigJam.
 *
 * Usage: node scripts/generate-figjam-data.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT        = resolve('.');
const DOCS_DIR    = join(ROOT, 'documents');
const PLUGIN_DIR  = join(ROOT, 'figjam-plugin');

// ── Read latest goals file ────────────────────────────────────────────────────

function latestGoalsFile() {
  const files = existsSync(DOCS_DIR)
    ? readdirSync(DOCS_DIR).filter(f => f.match(/^goals-\d{4}-\d{2}-\d{2}\.md$/)).sort()
    : [];
  if (files.length === 0) return null;
  return join(DOCS_DIR, files[files.length - 1]);
}

function readSafe(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

// ── Markdown parsers ──────────────────────────────────────────────────────────

function parseGoalTitle(md) {
  const m = md.match(/###\s+\d+\.\s+(.+)/);
  return m ? m[1].trim() : '$5k MRR — Claude Skills for Companies';
}

function parsePhases(md) {
  // Phases are marked by *Phase name* headers followed by - [ ] action lines
  const phasePattern = /\*([^*\n]+)\*\s*\n((?:[-*]\s+\[[ x]\].+\n?)+)/g;
  const phases = [];
  let match;

  while ((match = phasePattern.exec(md)) !== null) {
    const title   = match[1].trim();
    const actions = [...match[2].matchAll(/[-*]\s+\[[ x]\]\s+(.+)/g)]
      .map(m => m[1].trim())
      .filter(Boolean)
      .slice(0, 5); // max 5 actions per phase
    if (actions.length > 0) {
      phases.push({ title, actions });
    }
  }

  // Fallback if parsing fails
  if (phases.length === 0) {
    return [
      {
        title: 'Phase 1 — Offer',
        actions: [
          'Define cohort: 5–8 companies, 6-week, 2 calls/week',
          'Price at $1,000–1,500/company',
          'Add $300/mo retainer after cohort',
          'Write the one-line offer',
        ],
      },
      {
        title: 'Phase 2 — First Cohort',
        actions: [
          'Identify 10 companies from existing network',
          'Reach out directly — no landing page yet',
          'Offer founding rate for testimonials',
          'Document results with specific numbers',
        ],
      },
      {
        title: 'Phase 3 — Funnel',
        actions: [
          '1-page landing page, single CTA',
          '10–15 min VSL',
          'Lead magnet: free AI Readiness Audit',
        ],
      },
      {
        title: 'Phase 4 — Lead Gen',
        actions: [
          'LinkedIn: 3–5 posts/week',
          '20 personalized DMs/week to SMB owners',
          'Referrals after every client win',
        ],
      },
    ];
  }

  return phases;
}

function parseOffer(md) {
  const m = md.match(/##\s+One-Line Offer\s*\n([\s\S]+?)(?:\n##|\n---)/);
  return m ? m[1].replace(/^>\s*/gm, '').trim() : 'Stop running your business. Start leading it.';
}

// ── Build data object ─────────────────────────────────────────────────────────

const goalsFile = latestGoalsFile();
const goalsMd   = readSafe(goalsFile);
const offerMd   = readSafe(join(DOCS_DIR, 'offer.md'));

const data = {
  goal: {
    title:   parseGoalTitle(goalsMd),
    tagline: parseOffer(offerMd).split('\n')[0].slice(0, 120),
  },
  philosophy: [
    'Playful',
    'Sincere, not serious',
    'Non-attachment',
    'Intrinsic motivation',
    'Enjoyment as signal',
  ],
  phases: parsePhases(goalsMd),
  revenueMath: '📊 Revenue Math\n\n5 companies × $1,000\n= $5,000 MRR\n\n20 DMs/week → 2 replies\n→ 1 call/week → 1 client/month',
  generatedAt: new Date().toISOString().slice(0, 10),
  sourceFile: goalsFile ? goalsFile.replace(ROOT, '.') : 'no goals file found',
};

console.log(`\nGoal: ${data.goal.title}`);
console.log(`Phases: ${data.phases.map(p => p.title).join(', ')}`);
console.log(`Source: ${data.sourceFile}\n`);

// ── Generate ui.html ──────────────────────────────────────────────────────────

const dataJson = JSON.stringify(data, null, 2);

const uiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #1a1a1a;
      color: #e8e8e8;
      padding: 20px;
      font-size: 13px;
    }
    h2 { font-size: 16px; font-weight: 700; color: #fff; margin-bottom: 4px; letter-spacing: -0.01em; }
    .sub { font-size: 11px; color: #666; margin-bottom: 20px; }
    .preview { background: #111; border: 1px solid #2a2a2a; border-radius: 8px; padding: 14px; margin-bottom: 16px; }
    .preview-label { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #555; margin-bottom: 8px; }
    .goal-text { font-size: 13px; color: #a06cff; font-weight: 600; margin-bottom: 4px; }
    .tagline { font-size: 11px; color: #888; margin-bottom: 12px; line-height: 1.5; }
    .phases { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .phase-pill {
      font-size: 10px; padding: 4px 8px; border-radius: 6px;
      border: 1px solid #2a2a2a; color: #ccc; background: #1a1a1a;
    }
    .phase-pill span { display: block; font-size: 9px; color: #666; margin-top: 2px; }
    .status { font-size: 11px; color: #666; text-align: center; margin-bottom: 12px; min-height: 16px; }
    .status.error { color: #ff6c6c; }
    .btn {
      width: 100%; padding: 12px; border-radius: 8px; border: none;
      font-size: 13px; font-weight: 600; cursor: pointer;
      transition: opacity 0.1s;
    }
    .btn:hover { opacity: 0.85; }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .btn-create { background: #6c8eff; color: #fff; margin-bottom: 8px; }
    .btn-cancel { background: #2a2a2a; color: #888; }
    .meta { font-size: 10px; color: #333; text-align: center; margin-top: 12px; }
  </style>
</head>
<body>
  <h2>Goals Map</h2>
  <div class="sub">Generated ${data.generatedAt} from ${data.sourceFile}</div>

  <div class="preview">
    <div class="preview-label">What will be created</div>
    <div class="goal-text" id="goal-title"></div>
    <div class="tagline" id="goal-tagline"></div>
    <div class="phases" id="phases-list"></div>
  </div>

  <div class="status" id="status"></div>

  <button class="btn btn-create" id="btn-create" onclick="createMap()">
    Create Map in FigJam
  </button>
  <button class="btn btn-cancel" onclick="cancel()">Cancel</button>

  <div class="meta">
    ${data.phases.length} phases ·
    ${data.phases.reduce((n, p) => n + p.actions.length, 0)} actions ·
    ${data.philosophy.length} philosophy tags
  </div>

  <script>
    const DATA = ${dataJson};

    // Render preview
    document.getElementById('goal-title').textContent = DATA.goal.title;
    document.getElementById('goal-tagline').textContent = DATA.goal.tagline;
    const phasesEl = document.getElementById('phases-list');
    DATA.phases.forEach(p => {
      const el = document.createElement('div');
      el.className = 'phase-pill';
      el.innerHTML = \`\${p.title}<span>\${p.actions.length} actions</span>\`;
      phasesEl.appendChild(el);
    });

    function createMap() {
      document.getElementById('btn-create').disabled = true;
      document.getElementById('status').textContent = 'Building map...';
      parent.postMessage({ pluginMessage: { type: 'create-map', data: DATA } }, '*');
    }

    function cancel() {
      parent.postMessage({ pluginMessage: { type: 'cancel' } }, '*');
    }

    // Listen for status updates from code.js
    window.onmessage = (event) => {
      const msg = event.data.pluginMessage;
      if (!msg) return;
      if (msg.type === 'status') {
        document.getElementById('status').textContent = msg.text;
      }
      if (msg.type === 'error') {
        const el = document.getElementById('status');
        el.textContent = 'Error: ' + msg.text;
        el.className = 'status error';
        document.getElementById('btn-create').disabled = false;
      }
    };
  </script>
</body>
</html>`;

writeFileSync(join(PLUGIN_DIR, 'ui.html'), uiHtml, 'utf8');
console.log('✓ Wrote figjam-plugin/ui.html');
console.log('\nNext steps:');
console.log('  1. Open FigJam in the browser or desktop app');
console.log('  2. Resources (Shift+I) → Plugins → Development → Import plugin from manifest');
console.log('  3. Select: figjam-plugin/manifest.json');
console.log('  4. Run the plugin → click "Create Map in FigJam"\n');
