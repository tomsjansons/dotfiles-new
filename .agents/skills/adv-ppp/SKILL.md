---
name: adv-ppp
description: Reconstruct a week of work from the pi session transcripts in ~/.pi/agent/sessions and write the two weekly artifacts — the PPP (what got done, per project, in plain Latvian for a non-technical reader) and the timesheet (hours per day per task). Use when the user asks what they worked on last week, or asks for their PPP or timesheet for a week.
---

Two artifacts, one source of truth: the session transcripts under `~/.pi/agent/sessions`.

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

Read the whole output before writing anything. It has two views:

- **SESSIONS** — one line per top-level session, grouped by project: in-range active hours, the days touched, the issue ref from the worktree slug, a `+Nsub` count, and the best statement of what the session was about.
- **ACTIVITY** — hours per day per worktree, derived from every event timestamp including sub-agents, with idle gaps over 30 minutes dropped. This is the timesheet's skeleton.

Add `--json /tmp/week.json` when you want to sort or filter the sessions programmatically instead of re-parsing the prose.

Done when every project you are about to report on has a session line behind it, and every weekday in the range has an activity total.

### 3. Fill the gaps

Some session lines say `(no user prompt)` or carry one word (`agreed`, `q1: 1`) — those are continuation sessions. The worktree and issue already identify the work, but the content is missing. Drill in:

```
python3 ~/.agents/skills/adv-ppp/scan-sessions.py --session <slug> --limit 15
```

That prints the compaction goals, the user's own prompts, and the assistant's verdicts, which is enough to write the bullet. `--session` accepts a filename prefix, so the first few characters of the slug work.

All sessions sharing a worktree are one task. Drill once per worktree, not once per session.

### 4. Enrich from the tracker

The digest gives issue *numbers*; you need titles and, above all, whether the thing actually shipped. Resolve them where a tracker exists — `gh issue view <n> --json title,state` against the project repo, or the Linear MCP for `ADV-###`. The AdvanGrid repo is `AdvanGrid/advangrid` at `~/dev/advangrid`; `gh pr list` and `gh pr view` fill in what merged.

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

Before moving on, read the finished PPP as the manager would. Any line that would earn a follow-up question is not finished.

### 6. Write the timesheets

One line per day per task, hours rounded to the nearest 0.5:

```markdown
2026-09-24 - 1h - Planning
2026-09-24 - 4h - ADV-160 canonical-data merge: spec, PR stack, multi-model review
2026-09-24 - 2h - #1487 heap OOM: pod log forensics, heap snapshot
```

Built from the ACTIVITY view in this order:

1. Merge a day's worktree hours into one line per issue — a worktree appearing in four sessions is one timesheet line, not four.
2. Add `1h - Planning` to each weekday. That is the convention the existing sheet uses.
3. Weekday totals land at 8h. Where the sessions fall short, **say so** — `2.5h not in sessions (meetings? calls?)` — and let the user add the meetings, calls and off-machine work the transcripts cannot see. Never pad the session lines to close the gap.

Weekend days carry only what the sessions show, with no Planning line.

### 7. Report

Print both sections in the chat, in that order. Then add a short list of what to check: the days closest to light, anything that looked unresolved at the end of the week, and any project where a tracker lookup failed.

## Project map

The `project/detail` label the script prints maps to the PPP heading. Order in the PPP follows this table; edit both together when the reporting changes.

| script label | PPP heading | notes |
| --- | --- | --- |
| `advangrid` | Enerģijas Auditi | the worktree slug carries the issue ref; covers advagent, OCR, prod bugs, infra |
| `hermes` | Hermes | |
| `devinator` | Devinator | |
| `failiem-agent` | Failiem.lv agents | |
| `ino-day` | Ieviņas diena | pitch deck and copy work |
| `bash-ok`, `show-me` | — | only if something shippable came out of it |
| `home` | — | this report itself, skill authoring, research; usually omitted |
| `other` | — | inspect the `cwd` and decide |

Two audiences, two registers. The PPP goes to people who do not read code; the timesheet goes to whoever tracks the hours. Numbers, jargon and the tracker's own task names belong in the timesheet and nowhere else.

Order in the PPP follows this table.