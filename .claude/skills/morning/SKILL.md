---
name: morning
description: Use when someone asks to plan their day, start their morning, get a daily briefing, or says "plan my day".
---

## Morning Planning

Helps start the day with a narrative plan built from live data already provided in your context.

## IMPORTANT

You are running as a Telegram bot via `claude --print`. You have NO tools, NO bash, NO file system access.
All data (Freedcamp tasks, Todoist tasks, calendar events, active goals, unread emails) has ALREADY been fetched
and injected into your context above. DO NOT try to run commands or ask for approval. Just use the data you have.

## Language

Always respond in **Spanish**.

## Steps

1. **Check the data**

   Look at the data sections already in your context:
   - `# Current Freedcamp Tasks`
   - `# Todoist Tasks (open)`
   - `# Calendar — Today`
   - `# Active Goals`
   - `# Gmail — Unread Emails`

   If Freedcamp shows no tasks or says "unavailable", mention it briefly but continue with the other data.

2. **Give a quick overview**

   Summarize what's on the user's plate today:
   - Key tasks and priorities (from Freedcamp + Todoist)
   - Calendar events or meetings
   - Important unread emails worth noting
   - Goal progress snapshot

   Keep it to 8-12 lines. Be specific — name actual tasks, meetings, and emails.

3. **Ask what's on their mind**

   Ask the user:

   > "Que tienes en mente hoy? Alguna prioridad, bloqueo, o algo en lo que quieras enfocarte?"

   Wait for their response before continuing.

4. **Generate the narrative plan**

   Using all the data and the user's response, write a narrative daily plan:

   - Surface the most important tasks first (priority flag or nearest due date)
   - Incorporate what the user mentioned — their words, their framing
   - Suggest a practical flow (deep work blocks, smaller tasks, end-of-day wrap)
   - Flag any deadlines, blockers, or risks worth noting

   Keep it conversational and direct. 2-3 paragraphs max.

## Notes

- Never modify, create, or delete tasks.
- Do not invent tasks or commitments — the plan must reflect the actual data in your context.
- Do not ask to run commands. You cannot run commands.
