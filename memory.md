# Memory

> Curated long-term memory. Enduring facts, decisions, and context that survive sessions.
> Append new entries — never overwrite existing ones. Keep this file concise.

## Project Setup

- **Memory architecture:**
  - Markdown files = source of truth (soul.md, user.md, memory.md, agent.md)
  - `memory/YYYY-MM-DD.md` = daily episodic logs
  - `memory.db` = SQLite FTS5 index for full-text search across all markdown files
  - `memory_manager.mjs` = Node.js CLI to index, search, and manage memories

## Architecture Decisions

- FTS5 (full-text search) for keyword + BM25-style search via SQLite FTS5.
- Node.js built-in `node:sqlite` (stable in Node 22+).
- Storage schema: `files` + `chunks` + `chunks_fts` pattern.

## Key File Locations

| File | Purpose |
|------|---------|
| `soul.md` | Agent identity, values, tone, boundaries |
| `user.md` | User profile, preferences, active projects |
| `memory.md` | This file — curated long-term memory |
| `agent.md` | Operating instructions for the agent |
| `memory/YYYY-MM-DD.md` | Daily episodic logs |
| `memory.db` | SQLite FTS5 search index |
| `memory_manager.mjs` | CLI memory manager (Node.js) |

---

*Initialized on first install*
