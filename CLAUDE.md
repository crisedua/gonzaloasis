# AI Assistant

Installable AI assistant — a Telegram bot backed by a persistent Markdown + SQLite memory system.

## What This Project Is

A Telegram bot that gives conversational access to Claude (via `claude --print` subprocess, no API key needed).
Every exchange is logged to a daily Markdown file and re-indexed into a SQLite FTS5 search database.

## Installation

```bash
node scripts/install.mjs   # First-time setup (creates directories, DB, template files)
npm start                   # Start the bot + dashboard
```

Then visit `http://YOUR_IP:3456/setup` to configure Telegram, Google, Todoist, and Freedcamp via the web UI.

## Admin Panel

Available at `/d/admin` after setup. Configure integrations, test connections, manage credentials.

## Key Files

| File | Role |
|------|------|
| `bot.mjs` | Telegram adapter — main entry point (`npm start`) |
| `soul.md` | Agent identity, tone, behavioral rules |
| `user.md` | User profile and preferences |
| `memory.md` | Curated long-term facts (append-only) |
| `skill.md` | Guide for building and auditing Claude Code skills |
| `agent.md` | Operating instructions for the memory system |
| `calendar.mjs` | Google Calendar API helpers (view, create, search, delete events) |
| `memory_manager.mjs` | CLI: `index`, `search`, `list`, `stats`, `log` |
| `memory/YYYY-MM-DD.md` | Daily episodic logs |
| `memory.db` | SQLite FTS5 search index (derived — regenerate with `index`) |

## Memory Manager

```bash
node memory_manager.mjs index           # Re-index after file changes
node memory_manager.mjs search <query>  # Full-text search
node memory_manager.mjs log <text>      # Quick note to today's log
node memory_manager.mjs stats           # DB stats
```

## Goals Manager

```bash
node goals_manager.mjs index                    # Parse goals.md → upsert to SQLite
node goals_manager.mjs list [--status=active]   # List goals with status
node goals_manager.mjs update <id> <status>     # Change status (active/paused/completed/archived)
node goals_manager.mjs metric <id> <text>       # Log a metric update
node goals_manager.mjs stats                    # Summary counts by status
node goals_manager.mjs search <query>           # FTS5 search over goal titles + justifications
```

**Source of truth:** `goals.md` — edit directly, then run `index` to sync SQLite.

## Bot Commands

| Command | Action |
|---------|--------|
| `/start` | Welcome + memory file status |
| `/clear` | Wipe conversation history |
| `/status` | Show loaded memory files + model |
| `/search <q>` | DuckDuckGo web search, summarized by Claude |
| `/memory <q>` | FTS5 search across indexed memory |
| `/remember <text>` | Append fact to `memory.md` |
| `/doc <topic>` | Generate Markdown doc → `documents/` |
| `/fc [question]` | Freedcamp tasks/projects, optionally ask Claude |
| `/goals` | Start interactive goal review session |
| `/gstatus` | Quick summary of goal states (shows IDs) |
| `/gupdate <id> <status>` | Change goal status from Telegram |
| `/gmetric <id> <text>` | Log a metric update from Telegram |
| `/gadd <id> <action>` | Add a new action to a goal from Telegram |
| `/goals_diagram` | Generate + receive Excalidraw diagram via Telegram |
| `/tsync` | Push pending goal actions to Todoist |
| `/ttasks` | Show open Todoist tasks |
| `/gcal` | Show upcoming calendar events (next 10) |
| `/gcaltoday` | Show today's events only |
| `/gcalsearch <q>` | Search calendar events |
| `/gcalevent <id>` | Show full event details |
| `/gccreate <title> \| <start> \| <end> [\| desc] [\| loc]` | Create a calendar event |
| `/gcdelete <id>` | Delete a calendar event |
| `/expert [topic]` | Start AI Super Team session (Hormozi, Ogilvy, Gary Vee, Brunson, Suby) |

## Available Skills

### goals
**Location:** `.claude/skills/goals/SKILL.md`
**Invoke:** `/goals` or natural language: "help me with my goals", "goal review", "create my goals", "set goals"
**What it does:** Loads current goal state from `goals.md` via `goals_manager.mjs list`, reviews each active goal (what moved, what stalled), updates statuses and metrics in `goals.md`, re-indexes to SQLite, and writes a dated session summary.
**Source of truth:** `goals.md` — persistent, stateful, tracks active/paused/completed/archived
**Outputs:** `documents/goals-YYYY-MM-DD.md` (session summary only — what changed)
**Reference:** `.claude/skills/goals/hormozi.md` (Value Equation, Grand Slam Offer, funnel, VSL, outreach templates)

### morning
**Location:** `.claude/skills/morning/SKILL.md`
**Invoke:** `/morning` or natural language: "plan my day", "morning briefing", "start my day"
**What it does:** Fetches live Freedcamp tasks, asks what's on your mind, and generates a narrative daily plan. Logs the plan to today's memory file.
**Dependencies:** `scripts/fetch-freedcamp.mjs`, `memory_manager.mjs`, Freedcamp API credentials in `.env`

### delete-task
**Location:** `.claude/skills/delete-task/SKILL.md`
**Invoke:** `/delete-task` or natural language: "delete task", "remove task", "delete freedcamp task"
**What it does:** Lists all open Freedcamp tasks with IDs, asks which to delete, confirms before deleting, reports result.

### goals-diagram
**Location:** `.claude/skills/goals-diagram/SKILL.md`
**Invoke:** `/goals-diagram` or natural language: "visualize my goals", "generate goal diagram", "excalidraw diagram"
**What it does:** Runs `scripts/generate-goals-diagram.mjs` → produces `documents/goals-diagram.excalidraw`. Open at https://excalidraw.com.
**Output:** `documents/goals-diagram.excalidraw`

### lead-strategy
**Location:** `.claude/skills/lead-strategy/SKILL.md`
**Invoke:** `/lead-strategy` or natural language: "help me get leads", "create outreach strategy", "lead gen plan", "sales strategy", "help me get clients"
**What it does:** Runs a discovery interview, then generates a complete lead generation and outreach strategy using Alex Hormozi + Dan Martel frameworks. Produces Markdown doc + visual HTML brief.
**Output:** `documents/lead-strategy-YYYY-MM-DD.md` + `documents/lead-strategy-YYYY-MM-DD.html`
**Reference:** `.claude/skills/lead-strategy/hormozi-martel.md` (Value Equation, Grand Slam Offer, Dream 100, $100M Leads, Buy Back Your Time, DRIP Matrix)

### skill-builder
**Location:** `.claude/skills/skill-builder/SKILL.md`
**Invoke:** `/skill-builder` or natural language: "build a skill", "create a skill", "audit a skill", "optimize this skill"
**What it does:** Guides creation and auditing of Claude Code skills using a structured discovery interview.
**Reference:** `.claude/skills/skill-builder/reference.md`

### super-team
**Location:** `.claude/skills/super-team/SKILL.md`
**Invoke:** `/expert` or natural language: "audit my offer", "review my copy", "content strategy", "build my funnel", "get more leads", "super team"
**What it does:** Activates one of 5 AI expert personas — each embodies a specific marketing/sales expert's frameworks and thinking:
1. **Hormozi** — Offer Architect (Value Equation, Grand Slam Offer)
2. **Ogilvy** — Copy Chief (38 principles, AIDA, headline formulas)
3. **Gary Vee** — Content Strategist (Pillar-to-Micro, Jab Jab Right Hook)
4. **Brunson** — Funnel Architect (Value Ladder, Perfect Webinar, Hook-Story-Offer)
5. **Suby** — Lead Gen Strategist (8-Phase Selling, Godfather Offer, Dream 100)
**Output:** `documents/expert-<name>-YYYY-MM-DD.md` (session summary)

## Todoist Integration

**Client:** `todoist.mjs` — REST API v2, Bearer token auth
**Sync script:** `node scripts/sync-goals-todoist.mjs`
**Credential:** `TODOIST_API_TOKEN` in `.env`

Each active goal in `goals.md` maps to a Todoist **project** (created automatically if missing).
Each pending action (`- [ ]`) maps to a Todoist **task** (skipped if already exists by title).

```bash
node scripts/sync-goals-todoist.mjs   # Push all pending goal actions to Todoist
```

## FigJam Integration

**Plugin:** `figjam-plugin/` (manifest.json, code.js, ui.html)
**Generator:** `node scripts/generate-figjam-data.mjs`

Reads `documents/goals-*.md` → builds FigJam visual map (sticky notes + connectors).
Re-run the generator after every `/goals` session to keep the plugin data fresh.

**One-time setup in FigJam:**
Resources (Shift+I) → Plugins → Development → Import plugin from manifest → select `figjam-plugin/manifest.json`

## Conventions

- Node.js only — no Python, no bun
- No emojis unless explicitly requested
- Markdown + SQLite for all persistence
- Memory files are append-only — never overwrite existing entries
- Secrets go in `.env` (see `.env.example`), never hardcoded
