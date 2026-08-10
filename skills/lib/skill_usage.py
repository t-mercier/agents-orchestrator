#!/usr/bin/env python3
"""Skill usage tracker — derives per-skill activity from Claude Code transcripts.

Why transcripts and not a hook: a `PostToolUse` hook only sees skills the *agent*
invoked via the `Skill` tool. Skills the *user* types (`/close-session`) are injected
into the message without a tool call, so a hook never fires for them — it would
systematically undercount the most-used skills. The transcripts carry an
`attributionSkill` field written by the harness for BOTH paths, so that is the
source of truth here.

State model mirrors Hermes' curator (agent/curator.py): active → stale → archived,
driven by real activity, never by a model's judgement. Consolidation decisions are a
separate, content-based job (see the /skills-curate skill) — deliberately not here.

    python3 skill_usage.py scan      # incremental refresh of the state file
    python3 skill_usage.py report    # table: state, uses, last activity
    python3 skill_usage.py json      # the raw state, for another tool to read
    python3 skill_usage.py selftest  # pure-function checks, no I/O on real data

State lives in ~/.claude/skill-usage.json. Override roots with CLAUDE_HOME /
SKILL_USAGE_STATE for tests.
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

# Same thresholds as Hermes' curator defaults.
STALE_AFTER_DAYS = 30
ARCHIVE_AFTER_DAYS = 90

STATE_ACTIVE = "active"
STATE_STALE = "stale"
STATE_ARCHIVED = "archived"

NEEDLE = '"attributionSkill"'


def claude_home():
    return os.path.expanduser(os.environ.get("CLAUDE_HOME", "~/.claude"))


def state_path():
    return os.environ.get("SKILL_USAGE_STATE") or os.path.join(claude_home(), "skill-usage.json")


def load_state():
    try:
        with open(state_path()) as fh:
            data = json.load(fh)
    except Exception:
        data = {}
    data.setdefault("skills", {})
    data.setdefault("files", {})   # path → [size, mtime] already-scanned marker
    return data


def save_state(data):
    p = state_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
    os.replace(tmp, p)


def _iso(dt):
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sane_timestamp(ts, now=None):
    """Keep only plausible ISO timestamps. A clock-skewed transcript can carry a date
    in the future, which would make a skill look eternally fresh and immune to the
    stale transition — so anything more than a day ahead is dropped."""
    if not isinstance(ts, str) or len(ts) < 10:
        return None
    now = now or datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed > now + timedelta(days=1):
        return None
    return _iso(parsed)


def classify(last_activity, use_count, now, stale_days=STALE_AFTER_DAYS,
             archive_days=ARCHIVE_AFTER_DAYS):
    """The state machine. Pure, so selftest can pin it.

    The grace floor is Hermes' rule 4: a never-used skill is *absence* of evidence, not
    evidence of staleness — a skill created recently may simply not have had its trigger
    come up yet. So use_count == 0 never archives while younger than the stale window.
    """
    if not last_activity:
        return STATE_ACTIVE
    try:
        anchor = datetime.fromisoformat(last_activity.replace("Z", "+00:00"))
    except ValueError:
        return STATE_ACTIVE
    if anchor.tzinfo is None:
        anchor = anchor.replace(tzinfo=timezone.utc)
    age = (now - anchor).days
    if use_count == 0 and age < stale_days:
        return STATE_ACTIVE
    if age >= archive_days:
        return STATE_ARCHIVED
    if age >= stale_days:
        return STATE_STALE
    return STATE_ACTIVE


def scan(verbose=True):
    """Walk every transcript, folding attributionSkill lines into the state.

    Incremental: a file whose (size, mtime) is unchanged since the last scan is skipped
    entirely. Transcripts are append-only, so this makes a refresh cheap after the first
    full pass. Walks recursively — transcripts sit at BOTH
    projects/<proj>/<sid>.jsonl and projects/<proj>/<sid>/<...>.jsonl, so a fixed-depth
    glob silently misses most of them.
    """
    data = load_state()
    skills, files = data["skills"], data["files"]
    root = os.path.join(claude_home(), "projects")
    scanned = skipped = 0

    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            stamp = [st.st_size, int(st.st_mtime)]
            if files.get(path) == stamp:
                skipped += 1
                continue
            # A grown file is re-read whole: per-skill aggregates are min/max/set-union,
            # so re-folding the same lines is idempotent apart from `lines`, which we
            # therefore recompute per file rather than accumulate blindly.
            per_skill_sessions = {}
            try:
                with open(path, errors="ignore") as fh:
                    for line in fh:
                        if NEEDLE not in line:
                            continue
                        try:
                            rec = json.loads(line)
                        except Exception:
                            continue
                        skill = rec.get("attributionSkill")
                        if not isinstance(skill, str) or not skill:
                            continue
                        ts = sane_timestamp(rec.get("timestamp"))
                        sid = rec.get("sessionId") or rec.get("session_id") or path
                        slot = per_skill_sessions.setdefault(skill, {"sessions": set(), "ts": []})
                        slot["sessions"].add(sid)
                        if ts:
                            slot["ts"].append(ts)
            except OSError:
                continue

            for skill, agg in per_skill_sessions.items():
                row = skills.setdefault(skill, {"use_count": 0, "sessions": [],
                                                "first_seen_at": None, "last_activity_at": None})
                # use_count = distinct sessions the skill was used in. Counting attributed
                # LINES would conflate one long invocation with many short ones (a single
                # /close-session run attributes dozens of lines).
                known = set(row.get("sessions") or [])
                known |= agg["sessions"]
                row["sessions"] = sorted(known)
                row["use_count"] = len(known)
                if agg["ts"]:
                    lo, hi = min(agg["ts"]), max(agg["ts"])
                    if not row["first_seen_at"] or lo < row["first_seen_at"]:
                        row["first_seen_at"] = lo
                    if not row["last_activity_at"] or hi > row["last_activity_at"]:
                        row["last_activity_at"] = hi
            files[path] = stamp
            scanned += 1

    now = datetime.now(timezone.utc)
    for skill, row in skills.items():
        row["state"] = classify(row.get("last_activity_at"), row.get("use_count", 0), now)
    data["scanned_at"] = _iso(now)
    save_state(data)
    if verbose:
        print(f"scanned {scanned} transcript(s), skipped {skipped} unchanged; "
              f"{len(skills)} skill(s) tracked → {state_path()}")
    return data


def installed_skills():
    """Skill dirs on disk, so `report` can show what has NO usage record at all."""
    base = os.path.join(claude_home(), "skills")
    try:
        return sorted(
            d for d in os.listdir(base)
            if d != "lib" and os.path.isfile(os.path.join(base, d, "SKILL.md"))
        )
    except OSError:
        return []


def owner_of(name):
    """Who owns this skill — the curator must only ever touch what it owns.

    - "agent"    installed locally AND carries `origin: agent-proposed` → curatable.
    - "mine"     installed locally, hand-written by the user → suggest only, never move.
    - "external" not under ~/.claude/skills: a harness/plugin skill (`loop`, `simplify`,
                 `plugin:skill`) or the ghost of a renamed/removed one. Never touch.

    Mirrors Hermes' strict invariant: the background curator only acts on agent-created
    skills, because everything else is externally owned.
    """
    if ":" in name:
        return "external"
    path = os.path.join(claude_home(), "skills", name, "SKILL.md")
    if not os.path.isfile(path):
        return "external"
    try:
        with open(path, errors="ignore") as fh:
            head = fh.read(4000)
    except OSError:
        return "mine"
    return "agent" if "\norigin: agent-proposed" in head else "mine"


def report():
    data = load_state()
    skills = data["skills"]
    now = datetime.now(timezone.utc)
    rows = []
    for name, row in skills.items():
        last = row.get("last_activity_at") or ""
        rows.append((row.get("state", STATE_ACTIVE), row.get("use_count", 0), last, name))
    rows.sort(key=lambda r: (r[2] or ""), reverse=True)
    print(f"{'STATE':9s} {'USES':>5s}  {'LAST ACTIVITY':13s}  SKILL")
    for state, uses, last, name in rows:
        print(f"{state:9s} {uses:5d}  {last[:10] or '—':13s}  {name}")

    tracked = set(skills)
    never = [s for s in installed_skills() if s not in tracked]
    if never:
        print(f"\n{len(never)} installed skill(s) with NO recorded use "
              f"(absence of evidence — not a reason to prune):")
        print("  " + ", ".join(never))
    gone = sorted(n for n in tracked if owner_of(n) == "external")
    if gone:
        print(f"\n{len(gone)} tracked but NOT under ~/.claude/skills — harness/plugin "
              f"skills, or ghosts of renamed ones. Never curated:")
        print("  " + ", ".join(gone))
    if data.get("scanned_at"):
        print(f"\nlast scan: {data['scanned_at']}")


def candidates(include_mine=False):
    """The curation candidate list, ownership-filtered. `/skills-curate` reads this.

    Default is agent-proposed skills only. --include-mine widens it to hand-written
    skills so clusters can be *reported*, but those must never be archived or moved.
    """
    data = load_state()
    skills = data["skills"]
    rows = []
    for name in installed_skills():
        own = owner_of(name)
        if own == "agent" or (include_mine and own == "mine"):
            row = skills.get(name, {})
            rows.append((own, row.get("state", STATE_ACTIVE), row.get("use_count", 0),
                         (row.get("last_activity_at") or "")[:10] or "never", name))
    rows.sort(key=lambda r: (r[0] != "agent", r[4]))
    if not rows:
        print("(no curation candidates — no agent-proposed skill is installed yet)")
        return
    print(f"{'OWNER':8s} {'STATE':9s} {'USES':>5s}  {'LAST':10s}  SKILL")
    for own, state, uses, last, name in rows:
        print(f"{own:8s} {state:9s} {uses:5d}  {last:10s}  {name}")


def selftest():
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    def days_ago(n):
        return _iso(now - timedelta(days=n))
    checks = [
        ("used yesterday → active", classify(days_ago(1), 3, now), STATE_ACTIVE),
        ("used 45d ago → stale", classify(days_ago(45), 3, now), STATE_STALE),
        ("used 100d ago → archived", classify(days_ago(100), 3, now), STATE_ARCHIVED),
        ("boundary 30d → stale", classify(days_ago(30), 1, now), STATE_STALE),
        ("boundary 90d → archived", classify(days_ago(90), 1, now), STATE_ARCHIVED),
        ("never used, young → active (grace floor)", classify(days_ago(5), 0, now), STATE_ACTIVE),
        ("never used, old → archived", classify(days_ago(200), 0, now), STATE_ARCHIVED),
        ("no activity at all → active", classify(None, 0, now), STATE_ACTIVE),
        ("future timestamp dropped", sane_timestamp("2030-01-01T00:00:00Z", now), None),
        ("sane timestamp kept", sane_timestamp("2026-07-01T10:00:00Z", now), "2026-07-01T10:00:00Z"),
        ("garbage timestamp dropped", sane_timestamp("not-a-date", now), None),
    ]
    failed = 0
    for label, got, want in checks:
        ok = got == want
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  (got {got!r}, want {want!r})"))
    print(f"{len(checks) - failed}/{len(checks)} passed")
    return 1 if failed else 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    if cmd == "scan":
        scan()
    elif cmd == "report":
        report()
    elif cmd == "candidates":
        candidates(include_mine="--include-mine" in sys.argv)
    elif cmd == "json":
        print(json.dumps(load_state(), indent=2, sort_keys=True))
    elif cmd == "selftest":
        sys.exit(selftest())
    else:
        print("usage: skill_usage.py scan|report|candidates [--include-mine]|json|selftest",
              file=sys.stderr)
        sys.exit(1)


main()
