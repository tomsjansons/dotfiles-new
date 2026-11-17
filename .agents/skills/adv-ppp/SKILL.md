---
name: adv-ppp
description: Reconstruct a week of work from the pi and Claude Code session transcripts (~/.pi/agent/sessions, ~/.claude/projects) and write the two weekly artifacts — the PPP (what got done, per project, in plain Latvian for a non-technical reader) and the timesheet (hours per day per task). Use when the user asks what they worked on last week, or asks for their PPP or timesheet for a week.
---

Two artifacts, one source of truth: the session transcripts from both harnesses — pi under `~/.pi/agent/sessions` and Claude Code under `~/.claude/projects`. The scanner reads both into one digest, so a week split across them is still one week.

- **PPP** — what got done, grouped by project, in plain Latvian for a non-technical reader.
- **Timesheets** — hours per day per task.

Both are read back by the user every week, so the bar is that a third party could tell what shipped. Never invent a line — an hour or an outcome you cannot point at in the transcripts or a tracker is a fabrication.

## Process

### 1. Pin the week

Compute the previous Monday–Sunday and **read the two dates back to the user, then stop**. Do not scan, summarise, or guess at the range until they confirm it — "last week" means different things on a Monday and a Sunday, and a wrong range silently wastes the whole run.

```
python3 -c 'import datetime as d; t=d.date.today(); m=t-d.timedelta(days=t.weekday()); print(m-d.timedelta(days=7),"..",m-d.timedelta(days=1))'
```

If they name a different range, use theirs.

### 2. Scan

```
python3 ~/.agents/skills/adv-ppp/scan-sessions.py --from <mon> --to <sun>
```

Read the whole output before writing anything. It has three views:

- **SESSIONS** — one line per top-level session, grouped by project: the harness (`pi` or `cc`), in-range active hours, the days touched, the issue ref from the worktree slug, a `+Nsub` count, and the best statement of what the session was about.
- **ACTIVITY** — hours per day per worktree, derived from every event timestamp across both harnesses including sub-agents, with idle gaps over 30 minutes dropped. Overlapping sessions already count once, so a high total is not double counting: it is agents running while nobody was at the keyboard (loops through the night, sub-agent fan-out). This measures agent time, not the user's time. Use it to see where the work went, never for hours.
- **WORKTIME** — the user's own working time, built only from the prompts they sent. This is the timesheet's source. Read the rules under step 6.

T3 Code worktrees (`~/.t3/worktrees/<repo>/t3-<hash>`) are labelled `<repo>/t3-<hash>:<branch>`. The branch is read from the worktree as it is *now*, so it can be missing (worktree deleted) or point to a later task that reused the worktree. Check doubtful ones against the session's own prompt.

Pass `--claude-root ''` to scan pi alone. `--json /tmp/week.json` writes the digest (sessions, activity, worktime) to a file *instead of* printing the prose. A full week of Claude Code transcripts can take more than two minutes to scan, so run it in the background.

Done when every project you are about to report on has a session line behind it, and every weekday in the range has a worktime total.

### 3. Fill the gaps

Some session lines say `(no user prompt)` or carry one word (`agreed`, `q1: 1`) — those are continuation sessions. The worktree and issue already identify the work, but the content is missing. Drill in:

```
python3 ~/.agents/skills/adv-ppp/scan-sessions.py --session <slug> --limit 15
```

That prints the compaction goals, the user's own prompts, and the assistant's verdicts (plus Claude Code's away recaps), which is enough to write the bullet. `--session` accepts a filename prefix, so the first few characters of the slug work — for Claude Code that is the session uuid.

Claude Code sessions show the slash command as the prompt (`/adv-eng-loop 1225`). Where the first prompt is a single word, the line falls back to Claude Code's own session title.

All sessions sharing a worktree are one task. Drill once per worktree, not once per session.

### 4. Enrich from the tracker

The digest gives issue *numbers*; you need titles and, above all, whether the thing actually shipped. Resolve them where a tracker exists — `gh issue view <n> --json title,state` against the project repo, or the Linear MCP for `ADV-###`. The AdvanGrid repo is `AdvanGrid/advangrid` at `~/dev/advangrid`; `gh pr list` and `gh pr view` fill in what merged.

For AdvanGrid, also walk each issue up its parent chain to its `[Project]` issue. The PPP heading comes from there (see **AdvanGrid by tracker project** below):

```
gh api graphql -f query='{repository(owner:"AdvanGrid",name:"advangrid"){issue(number:<n>){parent{number title}}}}' -q '.data.repository.issue.parent'
```

Repeat with the parent's number until there is none. Parents are a strong hint, not the answer: tickets are not always filed under the right project, and an issue with no parent is classified by what it fixes.

A number with no fetched title stays a number. The numbers are for the timesheet and for your own confidence about what shipped — they never reach the PPP.

### 5. Write the PPP

Written for someone who does not read code: a manager who wants to know what now works, what it bought, and what comes next. Latvian, organised by project, latest state of the week first.

```markdown
Paveikts

- Enerģijas Auditi - {kur projekts šobrīd atrodas, vienā teikumā}
    - {kas vairs nenotiek un ko tas nozīmē klientam vai komandai}
    - {ko tas atver tālāk}
- Mārketinga/sales aktivitātes - {viena teikuma kopsavilkums}
- Failiem.lv agents - {viena teikuma kopsavilkums}
```

Project headings and their order come from the map at the bottom of this file. The project's own line says where it *stands* — "redzu gaismu tuneļa galā, palikušas 2 problēmas" beats "pabeigti 11 labojumi".

Every nested line answers at least one of: **what it helps with**, **what it opens up**, **how it improves the product, the infra, or the setup**. A line that only names the work ("strādāju pie X", "pārrakstīju Y") is not finished — say what the reader gets. Where a project moved toward a milestone, say how far.

**Group before you write.** A week of fifteen issues is two or three plain-language problems, not fifteen bullets. Fixes that removed the same class of breakage belong under one heading; a week of design and infrastructure work usually collapses into the project's summary line with no bullets at all. Fewer, broader lines read as confidence; an exhaustive list reads as noise.

**Translate, do not transcribe.** Real pairs from a week this skill was built against:

| the sessions say | the PPP says |
| --- | --- |
| `#1413` anomaly-list-sort-memory: 500 on the anomalies list, memory-bound sort | Anomāliju procesēšanās kļūdas |
| `#1415` file statuses: remapped the event→status model | Failu statusu atrādīšanas kļūdas |
| `#1379`/`#1378`/`#1408` state-model rework, pipeline redesign, platform spike | (absorbed into the project's summary line) |

Mechanisms are not outcomes. "Sandbox", "event loop", "heap", "session", "canonical data", "pipeline", "PR stack", "refactor" and every file, function and library name stay out. The outcome is what the mechanism bought: audits that used to stall now finish, the client's files all load, the team is no longer blocked on the old bottleneck. Keep numbers the reader cares about — failures eliminated, clients unblocked, hours saved — and drop the rest.

Drop tooling and personal-work items unless they produced something the company would recognise (a new capability, a process change). A project with nothing shippable behind it gets no heading, not an empty one; a week with little in it says so in one line.

**Short and intentful.** The PPP is skimmed, not read. Each line is one short clause that states the result, with no explanation of how it was reached:

- The project line is a status, ideally under 15 words.
- Nested lines are optional, at most four per project, and each one names a single outcome.
- Specific bug names, settings, counts and dates of decisions belong in the timesheet. Keep a number only when it carries the point ("~20x mazāki dati").
- A project whose week fits in one sentence gets no nested lines.

| too wordy | intentful |
| --- | --- |
| Izlabotas visas klienta (Revolt) atsauksmēs uz Starzinger auditu minētās aprēķinu kļūdas: viena un tā pati enerģija vairs netiek skaitīta vairākas reizes, atgūtais siltums netiek pieskaitīts patēriņam, … | Izlabotas visas aprēķinu kļūdas no klienta (Revolt) atsauksmēm |
| Vecā EMS platforma: atskaišu eksports vairs nebrūk no atmiņas trūkuma, platforma apkalpo vairāk vienlaicīgu pieprasījumu (32 apstrādātāji 12 vietā), un tagad redzams, kurš lietotājs … | Vecā EMS: atskaišu eksports vairs nebrūk, platforma iztur lielāku slodzi |
| four bullets on purges, alert noise, CI disk and a website deploy | Iekšējie uzlabojumi - atbrīvota vieta, samazināts brīdinājumu troksnis, LBRA mājaslapa darbojas uz mūsu infrastruktūras |

Before moving on, read the finished PPP as the manager would. Any line that would earn a follow-up question is not finished, and any line that tells the reader more than they would ask about is too long.

### 6. Write the timesheets

Hours are the user's real working time, taken from the clock: when they started, when they stopped and the breaks between. Agent run time does not count. Nothing is scaled to 8h and nothing is padded.

The **WORKTIME** view applies these rules. Know them, because the user will ask how a day was counted:

- **Your prompts only.** Every message the user sent in a top-level session, in either harness, slash commands included. These do not count: sub-agent transcripts, harness messages (T3 Code `Update on pull request…`, task notifications, `<…>` wrappers) and T3 Code's title-generator sessions.
- **Blocks.** Consecutive prompts up to 90 minutes apart form one block. A longer gap starts a new one, so 9:00–18:00 with a lunch break is one block, and 9:00–18:00 plus 21:00–23:00 is two.
- **Midnight.** A block counts whole toward the day it *started*. A block that starts before 05:00 belongs to the previous day. A session running past midnight is never split.
- **Lunch.** 0.5h comes off a block of 4h or more that runs through 12:00–13:30. When lunch already falls in a gap between blocks, nothing comes off.
- **Per task.** The time between two prompts goes to the worktree of the earlier prompt, which is where the user's attention was. The last prompt of each block adds 0.1h. That makes the per-task split approximate, while the day total is the solid number.

Turn it into the sheet:

1. Map every WORKTIME label to a timesheet task, using the worktree branch and the session drill-downs. All worktrees for one issue, or for one tight group (the issues of one epic, a day of ops incidents), become one line: `#2428 proc1->k3s migration: #2470 #2471 #2472`.
2. Round each line to the nearest 0.5. Fold lines under 0.25h into the related line, or into the day's largest line. Then adjust the largest line so the day adds up to its WORKTIME total rounded to 0.5.
3. Add `1h - Planning` to each weekday, *on top of* the session hours. That is the existing sheet's convention for planning and talks the transcripts can't see. Weekend days get no Planning line.
4. A weekday under 7h of sessions is not padded. Say so — `Mon: 3h in sessions (meetings? calls?)` — and let the user add what was off the machine.

```markdown
2026-11-10 - 1h - Planning
2026-11-10 - 3.5h - #2529 advagent v3 design: Go plan, ADR 0007
2026-11-10 - 2h - Legacy EMS ops: alerts, incidents, #2607 #2540 #2513
```

Next to the sheet, show a table per day with the blocks, session hours and the total including Planning. The user reads it to check the day against memory:

| Day | Blocks | Hours | With Planning |
| --- | --- | --- | --- |
| Tue 11-10 | 08:42–10:19, 12:03–17:41, 20:59–00:04 | 10.5h | 11.5h |

Also write the sheet to `timesheet-<monday>.tsv` in the working directory so it can be pasted into a spreadsheet:

- a header row `Date	Hours	Task`
- tab-separated columns
- hours as plain numbers with a **dot** decimal separator (`0.5`, not `0,5` or `0.5h`)

Before handing it over, check that each day's lines add up to its rounded WORKTIME total, plus Planning on weekdays.

### 7. Report

Print both sections in the chat, in that order, and link the TSV file. Then add a short list of what to check: the days closest to light, anything that looked unresolved at the end of the week, and any project where a tracker lookup failed.

## Project map

The `project/detail` label the script prints maps to the PPP heading. Order in the PPP follows this table; edit both together when the reporting changes.

| script label | PPP heading | notes |
| --- | --- | --- |
| `advangrid` | by tracker project | the worktree branch or slug carries the issue ref; the heading comes from the issue's `[Project]` parent, see below |
| `beghu` | beghu.dev | AdvanGrid's open-source issue tracker, run as a paid service; its prod deploy lives in the advangrid repo |
| `hermes` | Hermes | |
| `devinator` | Devinator | |
| `failiem-agent` | Failiem.lv agents | |
| `ino-day` | Ieviņas diena | pitch deck and copy work |
| `hermis/growth` | Mārketinga/sales aktivitātes | Claude Code in `~/hermis-agent-workspaces`; sales outreach projects |
| `hermis/operations` | — | ops errands for the company (presentations, files); fold into the project they served |
| `bash-ok`, `show-me` | — | only if something shippable came out of it |
| `scratch` | — | T3 Code scratch threads (research, one-off questions); fold into the project they served or omit |
| `home` | — | this report itself, skill authoring, research; usually omitted |
| `other` | — | inspect the `cwd` and decide |

### AdvanGrid by tracker project

These headings take the `advangrid` row's place in the PPP order, in this order.

| `[Project]` parent | PPP heading | what belongs here |
| --- | --- | --- |
| #552 Energy Audits | Enerģijas Auditi | audit features, plus audit-specific agent session work wherever it is filed: the merge, reconcile and analysis sessions, a client's audit files |
| #554 AI Agent Improvements | split: AI infrastruktūra / Enerģijas Auditi | general AI infrastructure goes to AI infrastruktūra: what every agent session gets regardless of task (workspaces, snapshots, sandbox capacity, model limits). Fixes to audit sessions go to Enerģijas Auditi |
| #548 AdvanGrid 2.0 | AdvanGrid/EMS/AdvanGrid2.0 | data lake, db2/db3 retirement, moving legacy features onto the new servers, the new login system |
| #551 Internal Improvements | Iekšējie uzlabojumi | security patches, legacy domain and DNS cleanup, preview environments, CI, dev workflow |

An issue with no parent, or one that is clearly filed under the wrong project, goes where its content points. When a fix was triggered in an audit session but also ships something general, put it where the reader felt the breakage and name the call in the report's check list.

Two audiences, two registers. The PPP goes to people who do not read code; the timesheet goes to whoever tracks the hours. Numbers, jargon and the tracker's own task names belong in the timesheet and nowhere else.

Order in the PPP follows this table.