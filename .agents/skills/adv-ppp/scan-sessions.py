#!/usr/bin/env python3
"""Digest ~/.pi/agent/sessions into a work log for a date range.

Two views of the same raw material:

  SESSIONS   - one line per top-level session: project, issue ref, in-range
               window, and the best available statement of what it was about
               (compaction goal > branch summary goal > first real user prompt).
               Sub-agent transcripts are folded into their parent's count.
  ACTIVITY   - every event timestamp from every session (main + sub-agent),
               merged into blocks with an idle-gap threshold, split per local
               day, apportioned across projects by event share.

Usage:
  scan-sessions.py --from 2026-09-21 --to 2026-09-27
  scan-sessions.py --from 2026-09-21 --to 2026-09-27 --json /tmp/week.json
  scan-sessions.py --session 2026-09-25T07-46-16-771Z_01a0d787-8041-70dc-a164-52958e9dbff7.jsonl
"""

from __future__ import annotations

import argparse
import collections
import datetime
import glob
import json
import os
import re
import sys
from zoneinfo import ZoneInfo

SESSIONS_ROOT = os.path.expanduser("~/.pi/agent/sessions")

# Prompts that are harness expansions or delegated briefs, never the user's own ask.
SYNTHETIC_PROMPT = re.compile(
    r"^(<|Research task|You are |Adversarial |Read the |Availability probe|"
    r"Perform |Follow-up on |I am rebuilding|Review the |Investigate )",
    re.I,
)

# Scratch sessions with no reporting value.
NOISE = re.compile(r"(tmp-pi-repro|/tmp/pi-repro)")

WEAK_TASK = 30


def parse_iso(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError, TypeError):
        return None


def start_from_filename(path):
    m = re.match(
        r"(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z", os.path.basename(path)
    )
    if not m:
        return None
    y, mo, d, h, mi, s, ms = (int(x) for x in m.groups())
    return datetime.datetime(y, mo, d, h, mi, s, ms * 1000, tzinfo=datetime.timezone.utc)


def block_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
    )


def squeeze(text, limit):
    t = re.sub(r"\s+", " ", text or "").strip()
    return t[:limit] + ("…" if len(t) > limit else "")


def goal_of(summary):
    """Pull the '## Goal' body out of a compaction / branch-summary blob."""
    if not summary:
        return ""
    m = re.search(r"##\s*Goal\s*\n(.+?)(?=\n#|\n<|\Z)", summary, re.S)
    if not m:
        return ""
    lines = [ln.strip() for ln in m.group(1).splitlines() if ln.strip()]
    return " ".join(lines)


def project_of(cwd):
    """(base, detail) - base groups work, detail is the worktree/topic."""
    cwd = cwd or ""
    m = re.match(r"/home/tomsj/\.herdr/worktrees/([^/]+)/(.+)", cwd)
    if m:
        return (m.group(1), m.group(2))
    m = re.match(r"/home/tomsj/dev/(.+)", cwd)
    if m:
        return (m.group(1), "")
    if cwd == "/home/tomsj":
        return ("home", "")
    if cwd.startswith("/home/tomsj/.agents"):
        return ("home", "agents-skills")
    return ("other", cwd.strip("/").replace("/", "-") or "unknown")


ISSUE_PATTERNS = (
    (re.compile(r"adv-(\d+)\s*$", re.I), lambda m: f"ADV-{m.group(1)}"),
    (re.compile(r"[-_]([0-9]{3,5})\s*$"), lambda m: f"#{m.group(1)}"),
)


def issue_ref(detail):
    for pattern, render in ISSUE_PATTERNS:
        m = pattern.search(detail or "")
        if m:
            return render(m)
    return ""


def load_session(path):
    cwd = parent = None
    events = []
    prompts = []
    goals = []

    with open(path, errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            kind = obj.get("type")
            if kind == "session":
                cwd = obj.get("cwd")
                parent = obj.get("parentSession")
                ts = parse_iso(obj.get("timestamp", ""))
                if ts:
                    events.append(ts)
                continue
            ts = parse_iso(obj.get("timestamp", ""))
            if ts:
                events.append(ts)
            if kind in ("compaction", "branch_summary"):
                g = goal_of(obj.get("summary"))
                if g:
                    goals.append(g)
            elif kind == "message":
                msg = obj.get("message") or {}
                if msg.get("role") == "user":
                    prompts.append(block_text(msg.get("content")))

    if not events:
        return None

    task = ""
    source = ""
    for g in goals:
        if len(g) > WEAK_TASK:
            task, source = g, "goal"
            break
    if not task:
        for p in prompts:
            t = re.sub(r"\s+", " ", p).strip()
            if t and not SYNTHETIC_PROMPT.match(t):
                task, source = t, "prompt"
                break
    if not task and prompts:
        task, source = re.sub(r"\s+", " ", prompts[0]).strip(), "prompt"

    return {
        "file": path,
        "slug": os.path.basename(path),
        "cwd": cwd,
        "parent": parent,
        "events": events,
        "task": task,
        "source": source,
        "weak": len(task) <= WEAK_TASK,
        "subagents": 0,
    }


def collect(root, tz, lo, hi):
    sessions = []
    for path in sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)):
        if NOISE.search(path):
            continue
        try:
            s = load_session(path)
        except OSError:
            continue
        if not s:
            continue
        s["local"] = [t.astimezone(tz) for t in s["events"] if lo <= t.astimezone(tz) < hi]
        if not s["local"]:
            continue
        sessions.append(s)

    by_id = {s["slug"]: s for s in sessions}
    for s in sessions:
        if s["parent"]:
            parent = by_id.get(os.path.basename(s["parent"]))
            if parent:
                parent["subagents"] += 1
    return sessions, by_id


def merge_blocks(points, gap, label=None):
    """Merge (timestamp, label) points into blocks; idle gaps over `gap` split.

    Pass `label` to merge bare timestamps belonging to a single label.
    """
    items = [(t, label) for t in points] if label else list(points)
    blocks = []
    if not items:
        return blocks
    a = b = items[0][0]
    counts = collections.Counter({items[0][1]: 1})
    for t, lbl in items[1:]:
        if t - b <= gap:
            b = t
            counts[lbl] += 1
        else:
            blocks.append((a, b, counts))
            a = b = t
            counts = collections.Counter({lbl: 1})
    blocks.append((a, b, counts))
    return blocks


def apportion(blocks):
    """Split each block's duration across its projects by event share, per day."""
    per_day = collections.defaultdict(collections.Counter)
    for a, b, counts in blocks:
        total = sum(counts.values())
        cursor = a
        while cursor < b:
            nxt = (cursor + datetime.timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            chunk = min(b, nxt)
            hours = (chunk - cursor).total_seconds() / 3600
            for label, n in counts.items():
                per_day[cursor.date()][label] += hours * (n / total)
            cursor = chunk
    return per_day


def report_range(sessions, tz, start, end, gap_minutes, as_json):
    top = [s for s in sessions if not s["parent"]]
    gap = datetime.timedelta(minutes=gap_minutes)
    first_day = datetime.datetime.fromisoformat(start).replace(tzinfo=tz)
    grouped = collections.defaultdict(list)
    for s in top:
        base, detail = project_of(s["cwd"])
        s["base"], s["detail"] = base, detail
        s["issue"] = issue_ref(detail)
        s["local"].sort()
        s["span_start"], s["span_end"] = s["local"][0], s["local"][-1]
        own = merge_blocks(s["local"], gap, label=base)
        s["active_h"] = sum((b - a).total_seconds() for a, b, _ in own) / 3600
        s["days"] = {a.date() for a, _, _ in own}
        origin = start_from_filename(s["file"])
        origin_local = origin.astimezone(tz) if origin else None
        s["carried"] = origin_local if origin_local and origin_local < first_day else None
        grouped[base].append(s)

    if not as_json:
        total_h = sum(s["active_h"] for s in top)
        first = datetime.datetime.fromisoformat(start).replace(tzinfo=tz)
        print(f"# sessions  {start} .. {end}  ({tz})")
        print(
            f"# {len(top)} top-level sessions, "
            f"{len(sessions) - len(top)} sub-agent transcripts, "
            f"{total_h:.1f}h of active session time"
        )
        for base in sorted(grouped):
            rows = sorted(grouped[base], key=lambda s: s["span_start"])
            print(f"\n## {base}  ({len(rows)})")
            for s in rows:
                tag = f" [{s['issue']}]" if s["issue"] else ""
                topic = f" {s['detail']}" if s["detail"] else ""
                sub = f" +{s['subagents']}sub" if s["subagents"] else ""
                prior = ""
                if s["carried"]:
                    prior = f" (started {s['carried']:%b %d})"
                days = ",".join(f"{d:%a}" for d in sorted(s["days"]))
                print(
                    f"  {s['active_h']:4.1f}h  {days:>14}  "
                    f"{s['span_start']:%H:%M}-{s['span_end']:%H:%M}"
                    f"{tag}{topic}{sub}{prior}"
                )
                print(f"        {squeeze(s['task'], 300) or '(no user prompt)'}")
                print(f"        {s['slug']}")

    points = []
    for s in sessions:
        base, detail = project_of(s["cwd"])
        label = f"{base}/{detail}" if detail else base
        for t in s["local"]:
            points.append((t, label))
    points.sort()
    per_day = apportion(merge_blocks(points, gap))

    if not as_json:
        print(f"\n# activity  (all sessions incl. sub-agents; idle >= {gap_minutes}min dropped)")
        for day in sorted(per_day):
            items = [(k, v) for k, v in per_day[day].most_common() if v >= 0.05]
            total = sum(v for _, v in items)
            print(f"\n## {day:%a %Y-%m-%d}  {total:.1f}h")
            for label, hours in items:
                print(f"  {hours:5.2f}h  {label}")

    if as_json:
        payload = {
            "range": {"from": start, "to": end, "tz": str(tz)},
            "truncated": False,
            "sessions": [
                {
                    "slug": s["slug"],
                    "project": s["base"],
                    "detail": s["detail"],
                    "issue": s["issue"],
                    "cwd": s["cwd"],
                    "start": s["span_start"].isoformat(),
                    "end": s["span_end"].isoformat(),
                    "active_hours": round(s["active_h"], 2),
                    "days": [str(d) for d in sorted(s["days"])],
                    "carried_over_from": s["carried"].isoformat() if s["carried"] else None,
                    "subagents": s["subagents"],
                    "weak": s["weak"],
                    "task_source": s["source"],
                    "task": squeeze(s["task"], 900),
                }
                for s in top
            ],
            "activity": {
                str(day): {k: round(v, 2) for k, v in per_day[day].items()}
                for day in sorted(per_day)
            },
        }
        with open(as_json, "w") as fh:
            json.dump(payload, fh, indent=1)
        print(f"wrote {as_json}", file=sys.stderr)


def report_session(path, tz, limit):
    """Readable transcript sketch for one session, for the drill-down step."""
    s = load_session(path)
    if not s:
        print(f"no such session: {path}", file=sys.stderr)
        return 1
    base, detail = project_of(s["cwd"])
    print(f"# {os.path.basename(path)}")
    print(f"# project={base} detail={detail or '-'} issue={issue_ref(detail) or '-'}")
    print(f"# cwd={s['cwd']}")
    print(f"# span={s['events'][0].astimezone(tz):%Y-%m-%d %H:%M}"
          f"-{s['events'][-1].astimezone(tz):%Y-%m-%d %H:%M}"
          f" ({len(s['events'])} events)")
    print()

    shown = 0
    with open(path, errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            kind = obj.get("type")
            ts = parse_iso(obj.get("timestamp", ""))
            stamp = f"{ts.astimezone(tz):%a %d %H:%M}" if ts else " " * 12
            if kind in ("compaction", "branch_summary"):
                g = goal_of(obj.get("summary")) or squeeze(obj.get("summary"), 400)
                print(f"[{stamp}] {kind.upper()}: {squeeze(g, 500)}\n")
                shown += 1
            elif kind == "message":
                msg = obj.get("message") or {}
                role = msg.get("role")
                if role == "user":
                    t = squeeze(block_text(msg.get("content")), 500)
                    if t and not SYNTHETIC_PROMPT.match(t):
                        print(f"[{stamp}] USER: {t}\n")
                        shown += 1
                elif role == "assistant":
                    content = msg.get("content")
                    if isinstance(content, list):
                        for part in content:
                            if isinstance(part, dict) and part.get("type") == "text":
                                t = squeeze(part.get("text"), 400)
                                if len(t) > 120:
                                    print(f"[{stamp}] SAYS: {t}\n")
                                    shown += 1
            if shown >= limit:
                print(f"... truncated at {limit} items")
                break
    return 0


def main():
    # Piping into `head` should end quietly, not with a BrokenPipeError trace.
    try:
        import signal

        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    except (ImportError, AttributeError, ValueError):
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", help="YYYY-MM-DD local, inclusive")
    ap.add_argument("--to", dest="end", help="YYYY-MM-DD local, inclusive")
    ap.add_argument("--tz", default="Europe/Riga")
    ap.add_argument("--gap", type=int, default=30, help="idle minutes that end a block")
    ap.add_argument("--root", default=SESSIONS_ROOT)
    ap.add_argument("--json", dest="json_out", help="also write a machine-readable digest")
    ap.add_argument("--session", help="drill into one session file (path or basename)")
    ap.add_argument("--limit", type=int, default=60, help="items printed by --session")
    args = ap.parse_args()

    tz = ZoneInfo(args.tz)

    if args.session:
        path = args.session
        if not os.path.exists(path):
            hits = glob.glob(os.path.join(args.root, "**", f"*{path}*"), recursive=True)
            if not hits:
                print(f"no session matching {path}", file=sys.stderr)
                return 1
            path = hits[0]
        return report_session(path, tz, args.limit)

    if not args.start or not args.end:
        print("--from and --to are required (or use --session)", file=sys.stderr)
        return 2

    lo = datetime.datetime.fromisoformat(args.start).replace(tzinfo=tz)
    hi = datetime.datetime.fromisoformat(args.end).replace(tzinfo=tz) + datetime.timedelta(days=1)
    sessions, _ = collect(args.root, tz, lo, hi)
    report_range(sessions, tz, args.start, args.end, args.gap, args.json_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
