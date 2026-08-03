---
name: import-session
description: >-
  Adopt the CURRENT (already-running) Claude Code session into management: writes
  a notes.md under a category's configured folder and registers the session in
  ~/.claude/active-sessions.json, so the dashboard tracks it like a /start-ed one.
  Meant to run right after `claude --resume <id>` (the dashboard's +Import does
  this for you). Unlike /start-session it does NOT create a fresh workspace or sync a repo —
  it binds the session you're already in. Trigger on "/import-session", "/import-session FEAT name".
allowed-tools: Bash Read Write AskUserQuestion
argument-hint: "<CATEGORY> [name]"
---

# /import-session — adopt the current session

Binds the session you're in (typically just `--resume`d) to a `notes.md` under a
category folder + registers it, so it shows up managed in the dashboard. Categories
and their folders come from your config — edit them in Settings, not here.

## Step 0 — Mode check

If plan mode is active (a `Plan mode is active` system reminder is present): stop and print:

> ⚠️ Plan mode is active — this skill writes files and will be blocked.
> Switch to auto mode, then re-run `/import-session`.

## Step 1 — Parse arguments + validate category

Read `$ARGUMENTS`. Form: `<CATEGORY> [name] [--root <space>]`.

- `CATEGORY` — uppercase it; it must be one of the configured categories:
  ```bash
  python3 ~/.claude/skills/lib/aoconfig.py categories
  ```
  If the list is **empty**, stop and print:
  > No categories configured. Add one in the app's **Settings** (or via **＋New**) first — a session needs a category folder to live under.

  If `CATEGORY` isn't in the list, prompt with `AskUserQuestion` (offer the listed categories).
- `ROOT` — if a `--root <space>` token appears (the dashboard's Import passes it when more than one space is configured, to pick which space the imported session lands under), capture `<space>` as `ROOT` and **remove `--root <space>` from the args** before computing NAME. Else empty.
- `NAME` — everything after the category (after stripping any `--root <space>`). If absent, derive a short slug from the session's first goal/topic, or ask with `AskUserQuestion` ("Short name for this session? 3–6 words").

## Step 2 — Resolve the CURRENT session ID

This is the session we're adopting (the one this skill runs in — i.e. the resumed one).

```bash
SESSION_ID=$(python3 -c "
import json, os, glob, subprocess
def ancestors(pid):
    result = set()
    while pid > 1:
        try:
            out = subprocess.run(['ps','-p',str(pid),'-o','ppid='], capture_output=True, text=True).stdout.strip()
            pid = int(out); result.add(pid)
        except: break
    return result
mine = ancestors(os.getpid())
for f in sorted(glob.glob(os.path.expanduser('~/.claude/sessions/*.json')), key=os.path.getmtime, reverse=True):
    try:
        pid = int(os.path.basename(f).replace('.json',''))
        if pid in mine:
            d = json.load(open(f)); sid = d.get('sessionId','')
            if sid: print(sid); break
    except Exception: pass
")
```

If empty, abort: "Couldn't resolve the current session id — is this running inside `claude`?"

## Step 3 — Compute slug + path; abort if already managed

```bash
slug() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'; }
FOLDER=$(slug "$NAME")
[ -z "$FOLDER" ] && FOLDER="imported-$(echo "$SESSION_ID" | cut -c1-8)"
# A chosen space (ROOT, from the dashboard) disambiguates a category present under
# several spaces; empty ROOT → aoconfig uses the category's own root.
TARGET_DIR=$(python3 ~/.claude/skills/lib/aoconfig.py dir "$CATEGORY" "$FOLDER" ${ROOT:+"$ROOT"})
NOTES_PATH="$TARGET_DIR/notes.md"
```

If `notes.md` already exists at `$NOTES_PATH`, abort: "Already managed at `$NOTES_PATH` — use `/restart-session $FOLDER` to reopen." Do NOT overwrite.

## Step 3.5 — Collision guard (NEVER hijack an active session)

Step 6 binds **this terminal's** `SESSION_ID` to `$NOTES_PATH`. Step 3 only checked the
TARGET folder; this checks the other direction — whether this terminal is already the active
session for *different* work. If it is, registering would silently re-point the id and
**detach that session** from the active list (its `notes.md` survives on disk, but it
disappears from the dashboard and from `/list-sessions`). Same guard as `/start-session`
Step 4.5.

```bash
EXISTING=$(python3 - "$SESSION_ID" "$NOTES_PATH" <<'PY'
import json, os, sys
sid, target = sys.argv[1], sys.argv[2]
p = os.path.expanduser('~/.claude/active-sessions.json')
try: d = json.load(open(p))
except Exception: d = {}
cur = (d.get(sid) or {}).get('notes_path', '')
# Collision only if this terminal is already bound to a DIFFERENT, still-existing workspace.
if cur and os.path.abspath(cur) != os.path.abspath(target) and os.path.exists(cur):
    print(cur)
PY
)
```

- **`$EXISTING` empty** → unmanaged terminal, which is what `/import-session` is for: proceed normally through Steps 4–7.
- **`$EXISTING` non-empty** → there is nothing to adopt: this terminal is ALREADY managed as `$EXISTING`. Do NOT silently proceed. Use `AskUserQuestion`:
  - **Keep the existing binding (default, recommended)** — **stop here and write nothing**: skip Steps 4–7 (no notes.md, no `active-sessions.json` write). Print that this terminal is already managed as `$EXISTING`; to reopen a *different* workspace here, `/restart-session <slug>` is the right command.
  - **Re-bind this terminal to the new workspace (only if the current work is truly done)** — proceed normally through Steps 4–7; the old binding detaches (its `notes.md` stays on disk, reopen it later with `/restart-session`).

## Step 4 — Resolve branch

```bash
if git rev-parse --git-dir >/dev/null 2>&1; then BRANCH=$(git branch --show-current); else BRANCH=""; fi
```

## Step 5 — Write the notes.md

```bash
mkdir -p "$TARGET_DIR"
NOW=$(date +"%Y-%m-%d %H:%M"); TODAY=$(date +%Y-%m-%d)
```

Write `$NOTES_PATH` (Write tool), substituting the bracketed values. Fill the Goal +
Next steps from what you can infer about the conversation so far (it's already loaded);
leave them as a short prompt if unclear.

```markdown
---
session_id: <SESSION_ID>
category: <CATEGORY>
ticket: <TICKET if one is obvious from the work, else empty>
name: <NAME>
branch: <BRANCH or "to fill">
started_at: <NOW>
---

# <NAME>

## Goal
<one line inferred from the conversation, or "imported — fill in">

## Branch
<BRANCH or "to fill">

## Decisions made
- <TODAY>: imported into <CATEGORY> from an existing Claude Code session.

## Files touched
- …

## Open questions
- [ ] …

## Next steps
1. …

## Session history
- <NOW> (in progress) | session=<SESSION_ID> | imported into <CATEGORY> via the dashboard
```

> The `(in progress)` marker matters: an imported session is **open work**, not closed.
> A history line with `session=` but no `(in progress)` reads as a completed
> `/close-session` to the dashboard (reader.rs `is_wrapped_up`), so without it a freshly
> imported session whose terminal is closed same-day would wrongly show under **Closed**
> instead of Running/stale. `/close-session` later appends a line WITHOUT the marker to
> file it under Closed.

## Step 6 — Register in active-sessions.json

```bash
python3 - <<EOF
import json, os
p = os.path.expanduser('~/.claude/active-sessions.json')
data = {}
if os.path.exists(p):
    try: data = json.load(open(p))
    except: data = {}
data['$SESSION_ID'] = {
    'notes_path': '$NOTES_PATH',
    'category': '$CATEGORY',
    'ticket': '',
    'name': '$NAME',
    'started_at': '$NOW',
}
tmp = p + '.tmp'
json.dump(data, open(tmp,'w'), indent=2)
os.replace(tmp, p)
EOF
```

## Step 7 — Confirm

Print a short confirmation: imported `<NAME>` into `<CATEGORY>`, notes at `$NOTES_PATH`,
registered. Remind the user the dashboard picks it up on its next 5-second poll (it's
live now → **Running**), and that `/close-session` will file it under Closed when they're done.
