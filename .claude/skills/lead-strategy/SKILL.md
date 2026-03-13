---
name: lead-strategy
description: Use when someone asks to create a lead generation strategy, get more leads, need help with lead gen, build an outreach plan, create a sales strategy, write lead scripts, plan their go-to-market, or says "help me get clients".
disable-model-invocation: true
---

## What This Skill Does

Generates a complete lead generation and outreach strategy using Alex Hormozi and Dan Martel frameworks. Produces a Markdown strategy document and a visual HTML brief.

## Context

Before starting, read these files for product and user context:
- `user.md` — who the user is, what they build, their philosophy
- `goals.md` — active goals and business context (if it exists)
- `.claude/skills/lead-strategy/hormozi-martel.md` — full framework reference (Value Equation, Grand Slam Offer, Dream 100, $100M Leads, Buy Back Your Time, DRIP Matrix, 90-Day Sprint)

## Steps

1. **Load context**

   Read `user.md` and `goals.md` (if it exists) to understand the user's business context. Read `.claude/skills/lead-strategy/hormozi-martel.md` for the strategy frameworks.

2. **Run the discovery interview**

   Ask the user these questions using AskUserQuestion, one round at a time. Wait for answers before continuing.

   **Round 1:**
   - "What product or service are we building this strategy for?" (options: AI Operating System for businesses, AI assistant/second brain bot, Custom AI agents, Other)
   - "Who's your ideal customer? Be as specific as possible." (options: SMB founders doing $500k-$5M revenue, Agency owners with 5-20 employees, Solo consultants/coaches, Other)

   **Round 2:**
   - "What's your current lead gen situation?" (options: Starting from zero, Have some leads but no system, Have a system but it's not working, Need to scale what's working)
   - "What channels are you currently using?" (multiselect: LinkedIn, Email outreach, Content/social media, Referrals, Paid ads, None yet)

   **Round 3:**
   - "How much time per week can you dedicate to sales and outreach?" (options: 2-5 hours, 5-10 hours, 10-20 hours, Full time)
   - "What's your pricing model?" (options: One-time project fee $5k-$20k, Monthly retainer $1k-$5k, Subscription/SaaS, Not defined yet)

3. **Generate the strategy**

   Using the interview answers AND the hormozi-martel.md frameworks, generate a complete strategy document. The strategy MUST include ALL of these sections:

   ### Section 1: ICP Definition
   - Specific person (name, title, company size, revenue range)
   - Their top 3 pains (using Hormozi's problem identification)
   - Where they spend time online
   - What they've tried before (and why it failed)

   ### Section 2: Grand Slam Offer
   - Apply the Value Equation to the user's product
   - One-line offer statement
   - Full offer stack (what's included, value of each piece)
   - Guarantee or risk reversal

   ### Section 3: Lead Magnet
   - Recommend 2-3 lead magnets based on the ICP
   - For each: title, format, what problem it solves, CTA

   ### Section 4: Outreach Strategy
   - Warm outreach plan (existing network)
   - Cold outreach plan (DM + email templates, customized for their ICP)
   - Dream 100 list categories (who to target)
   - Follow-up cadence

   ### Section 5: Content Strategy
   - Platform recommendation (pick ONE primary)
   - Content pillars (3-4 themes)
   - Weekly posting cadence
   - CTA strategy for each post type

   ### Section 6: Lead Scripts
   - Cold DM script (customized for their product)
   - Cold email script (customized)
   - Discovery call script (customized)
   - Follow-up scripts (3 variations)
   - Objection handling responses

   ### Section 7: Weekly Action Plan
   - Use Martel's Perfect Week template adapted to their time budget
   - Specific daily activities
   - Weekly targets (messages sent, calls booked, etc.)

   ### Section 8: 90-Day Sprint
   - Week-by-week milestones
   - What to track each week
   - Decision points (when to pivot, when to double down)

   ### Section 9: KPIs and Tracking
   - Metrics dashboard (what to track weekly)
   - Targets for each metric
   - What to do when a metric is below target

   ### Section 10: Buyback Your Time Plan
   - Map which activities can be delegated to AI
   - Which can be automated (n8n, agents)
   - What only the founder should do
   - Tie this back to the user's AI Operating System philosophy

4. **Write the Markdown document**

   Write the strategy to `documents/lead-strategy-YYYY-MM-DD.md` using today's date.

   Format with clear headers, bullet points, templates in code blocks, and tables for metrics.

5. **Write the HTML brief**

   Write `documents/lead-strategy-YYYY-MM-DD.html` using this structure:

   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
     <title>Lead Strategy — [DATE]</title>
     <style>
       *{box-sizing:border-box;margin:0;padding:0}
       body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh}
       .topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 28px;border-bottom:1px solid #1e1e1e;background:#0d0d0d}
       .topbar h1{font-size:15px;font-weight:600;color:#fff}
       .topbar .date{font-size:12px;color:#666}
       .page{max-width:960px;margin:0 auto;padding:40px 28px}
       .title{font-size:32px;font-weight:700;letter-spacing:-0.02em;color:#fff;margin-bottom:6px}
       .title span{color:#ff8c6e}
       .sub{font-size:14px;color:#666;margin-bottom:36px}
       .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
       @media(max-width:700px){.grid{grid-template-columns:1fr}}
       .card{background:#111;border:1px solid #1e1e1e;border-radius:14px;padding:24px}
       .card.full{grid-column:1/-1}
       .card-label{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#555;margin-bottom:14px}
       .card h3{font-size:16px;color:#fff;margin-bottom:10px}
       .card p,.card li{font-size:13px;color:#bbb;line-height:1.7}
       .card ul{list-style:none;display:flex;flex-direction:column;gap:8px}
       .card ul li::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff8c6e;margin-right:10px;vertical-align:middle}
       .highlight{background:#1a1410;border-color:#332211}
       .offer-box{background:#0d1a0d;border:1px solid #1a331a;border-radius:10px;padding:18px;margin-top:12px;font-size:14px;color:#8f8;line-height:1.6}
       .metric{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1a1a1a;font-size:13px;color:#bbb}
       .metric:last-child{border:none}
       .metric .val{color:#ff8c6e;font-weight:600}
       .script{background:#0a0a0a;border:1px solid #222;border-radius:8px;padding:14px;font-size:13px;color:#aaa;line-height:1.7;white-space:pre-wrap;margin-top:10px}
       .week-block{margin-bottom:16px}
       .week-block h4{font-size:13px;color:#ff8c6e;margin-bottom:6px}
       .footer{margin-top:48px;padding-top:16px;border-top:1px solid #1a1a1a;font-size:12px;color:#333;text-align:center}
     </style>
   </head>
   <body>
     <div class="topbar">
       <h1>Lead Strategy</h1>
       <span class="date">[DATE]</span>
     </div>
     <div class="page">
       <div class="title">Lead Generation <span>Playbook</span></div>
       <div class="sub">Built on Hormozi + Martel frameworks for [PRODUCT]</div>
       <div class="grid">
         <!-- ICP Card -->
         <div class="card">
           <div class="card-label">Ideal Customer</div>
           [ICP_CONTENT]
         </div>
         <!-- Offer Card -->
         <div class="card highlight">
           <div class="card-label">Grand Slam Offer</div>
           <div class="offer-box">[OFFER_STATEMENT]</div>
         </div>
         <!-- Lead Magnets Card -->
         <div class="card">
           <div class="card-label">Lead Magnets</div>
           [LEAD_MAGNETS]
         </div>
         <!-- Channels Card -->
         <div class="card">
           <div class="card-label">Outreach Channels</div>
           [CHANNELS]
         </div>
         <!-- Scripts Card (full width) -->
         <div class="card full">
           <div class="card-label">Key Scripts</div>
           [SCRIPTS]
         </div>
         <!-- Weekly Plan Card (full width) -->
         <div class="card full">
           <div class="card-label">Weekly Action Plan</div>
           [WEEKLY_PLAN]
         </div>
         <!-- 90-Day Sprint Card (full width) -->
         <div class="card full">
           <div class="card-label">90-Day Sprint</div>
           [SPRINT_CONTENT]
         </div>
         <!-- KPIs Card -->
         <div class="card">
           <div class="card-label">KPIs to Track</div>
           [KPIS]
         </div>
         <!-- Buyback Card -->
         <div class="card">
           <div class="card-label">Buy Back Your Time</div>
           [BUYBACK]
         </div>
       </div>
       <div class="footer">Generated [DATE] | Hormozi + Martel Frameworks</div>
     </div>
   </body>
   </html>
   ```

   Replace all `[BRACKETED]` placeholders with real content from the strategy. Keep the HTML structure intact. Fill every card with actual data.

6. **Log the strategy**

   ```
   node memory_manager.mjs log "Lead strategy generated: [one-line summary of the offer + ICP]"
   ```

7. **Present to the user**

   Tell the user:
   - The strategy files have been written (with paths)
   - Summarize the Grand Slam Offer in 2-3 sentences
   - Highlight the top 3 immediate actions they should take this week
   - Mention the 90-day sprint structure

## Notes

- All scripts and templates must be customized to the user's specific product, ICP, and context. Never use generic placeholders like "[insert name]" in the final output.
- Ground all recommendations in the Hormozi/Martel frameworks — don't invent approaches.
- Be specific about numbers: how many outreach per week, how many posts, how many calls.
- The weekly plan must fit within the time budget the user specified.
- Do NOT promise specific revenue numbers. Use ranges and conditional language.
- If the user's product/offer isn't defined yet, help them define it as part of the strategy (using the Value Equation and Grand Slam Offer frameworks).
- The HTML brief should be visually complete and ready to open in a browser — not a skeleton with placeholders.
