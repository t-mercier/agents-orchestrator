---
name: start-session
description: >-
  Open a new session: creates a workspace + notes.md under the category's
  configured folder, registers it in ~/.claude/active-sessions.json, syncs the
  git repo, and renames the session. Categories & note locations come from your
  config. Aborts if the workspace already exists (use /restart-session instead).
  Trigger on "/start-session", "start a session", "/start-session FEAT PROJ-123 short-name".
allowed-tools: Bash Read Write AskUserQuestion
argument-hint: "<CATEGORY> <TICKET-OR-NAME> [name]"
---

# /start-session — open a session

Bootstraps a per-session workspace with a `notes.md`, registers the active
session, and syncs the git repo. Categories and their folders come from your
config (`~/.config/ai-agents-orchestrator/config.json`) — edit them in the app's
Settings, not here.

## Step 0 — Mode check

If plan mode is active (a `Plan mode is active` system reminder is present): stop and print:

> ⚠️ Plan mode is active — this skill writes files and will be blocked.
> Switch to auto mode, then re-run `/start-session`.

## Step 1 — Parse arguments

Read `$ARGUMENTS`. Forms: `<CATEGORY> <TICKET-OR-NAME>`, `<CATEGORY> <TICKET> <name>`,
or empty/partial → prompt for missing fields with `AskUserQuestion`.

- `CATEGORY` — uppercase it; it must be one of the configured categories:
  ```bash
  python3 ~/.claude/skills/lib/aoconfig.py categories
  ```
  If it isn't in that list, prompt with `AskUserQuestion` (offer the listed
  categories, or tell the user to add it in Settings / via the +New dialog).
- `TICKET` — keep only if it matches `^[A-Za-z][A-Za-z0-9]*-[0-9]+$` (e.g. `PROJ-1234`); uppercase it. Else empty.
- `PR_LINK` — if a `--pr <url>` token appears (the dashboard's +New passes it for REVIEW sessions), capture `<url>` and **strip `--pr <url>` from the args** before computing NAME. Keep only a GitHub PR URL (`https://github.com/owner/repo/pull/N`); else empty. Default empty.
- `ROOT` — if a `--root <space>` token appears (the dashboard's +New passes it when more than one space is configured, to pick which space a category that exists in several should land under), capture `<space>` and **strip `--root <space>` from the args** before computing NAME. Else empty.
- `NAME` — anything else (after stripping any `--pr <url>` and `--root <space>`). If absent and a `TICKET` was given, ask for a short name (3–6 words).

## Step 2 — Compute slug + path

```bash
slug() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'; }
if [ -n "$TICKET" ]; then FOLDER="$TICKET"; else FOLDER=$(slug "$NAME"); fi
# Pass ROOT (the chosen space) only when set — it disambiguates a category that
# exists under several spaces. Empty ROOT → aoconfig uses the category's own root.
TARGET_DIR=$(python3 ~/.claude/skills/lib/aoconfig.py dir "$CATEGORY" "$FOLDER" ${ROOT:+"$ROOT"})
NOTES_PATH="$TARGET_DIR/notes.md"
```

## Step 3 — Abort if already started

If `notes.md` already exists at `$NOTES_PATH`, abort:

> Already exists at `$NOTES_PATH`. Use `/restart-session $FOLDER` to reopen it in this session.

Do NOT overwrite.

## Step 4 — Resolve session ID

```bash
SESSION_ID=$(python3 -c "
import json, os, glob, subprocess

def ancestors(pid):
    result = set()
    while pid > 1:
        try:
            out = subprocess.run(['ps', '-p', str(pid), '-o', 'ppid='],
                                 capture_output=True, text=True).stdout.strip()
            pid = int(out)
            result.add(pid)
        except: break
    return result

mine = ancestors(os.getpid())
for f in sorted(glob.glob(os.path.expanduser('~/.claude/sessions/*.json')), key=os.path.getmtime, reverse=True):
    try:
        pid = int(os.path.basename(f).replace('.json', ''))
        if pid in mine:
            d = json.load(open(f))
            sid = d.get('sessionId', '')
            if sid:
                print(sid)
                break
    except Exception:
        pass
else:
    pwd = os.getcwd()
    candidates = []
    for f in glob.glob(os.path.expanduser('~/.claude/sessions/*.json')):
        try:
            d = json.load(open(f))
            candidates.append((d.get('sessionId'), d.get('cwd',''), d.get('status',''), os.path.getmtime(f)))
        except Exception:
            pass
    busy = sorted([c for c in candidates if c[1] == pwd and c[2] == 'busy'], key=lambda c: -c[3])
    print(busy[0][0] if busy else (sorted(candidates, key=lambda c: -c[3])[0][0] if candidates else ''))
")
```

If empty, fall back to `SESSION_ID="unknown"`.

## Step 4.5 — Collision guard (NEVER hijack an active session)

`SESSION_ID` is **this terminal's** session. `/start-session` binds the current terminal to the new ticket — so if this terminal is ALREADY an active session for *different* work, proceeding would silently re-point the id to the new ticket and **detach the existing session** from the active list (its `notes.md` survives on disk, but it vanishes from the dashboard / `/list-sessions` active view). This has bitten us more than once: a session started to continue *already-underway* work must become its OWN session, not cannibalize the current one.

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

- **`$EXISTING` empty** → fresh terminal (or the id already points at this same workspace): proceed normally through Steps 5–9.
- **`$EXISTING` non-empty** → this terminal is the live session for `$EXISTING`. Do NOT silently proceed. Use `AskUserQuestion`:
  - **New session in a fresh terminal (default, recommended)** — keep this terminal on its current session. Still create the new workspace + real notes/brief (Step 6 + 6.5) so it's ready, but write its frontmatter `session_id:` **empty** and `branch:` as `to fill` (the new terminal creates the real branch on open), and **SKIP Step 7 (register), Step 8 (git sync) and Step 9 (rename)** — do not touch `active-sessions.json` or the current terminal's git branch. Then tell the user to open a new terminal (dashboard **+New**, or `claude` in a shell) and run `/restart-session <FOLDER>` to bind it there. Both sessions stay intact and recoverable.
  - **Re-bind this terminal (only if the current work is truly done)** — proceed normally through Steps 5–9; the current session detaches (its `notes.md` stays on disk, reopen later with `/restart-session`).

## Step 5 — Resolve branch

```bash
if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current)
else
  BRANCH=""
fi
```

If `$BRANCH` is empty (no repo or detached HEAD), use `AskUserQuestion`:
"What branch should I record in notes.md? (leave blank to fill later)".

## Step 6 — Create the workspace

```bash
mkdir -p "$TARGET_DIR"
NOW=$(date +"%Y-%m-%d %H:%M")
TODAY=$(date +%Y-%m-%d)
TITLE="${NAME:-$TICKET}"
```

Write `$NOTES_PATH` (Write tool), substituting the bracketed values:

```markdown
---
session_id: <SESSION_ID>
category: <CATEGORY>
ticket: <TICKET or empty>
name: <NAME>
branch: <BRANCH or "to fill">
pr_link: <PR_LINK or empty>
started_at: <NOW>
---

# <TITLE>

## Goal
<one-line why — FILL IN>

## Branch
<BRANCH or "to fill">

## Decisions made
- <TODAY>: …

## Files touched
- …

## Open questions
- [ ] …

## Next steps
- [ ] …

## Session history
```

A new session starts with at most one PR and one ticket, so the template writes the plain
`pr_link:` / `ticket:` keys. Should the work later span several (a task split across two
PRs, an epic plus its sub-task), `/save-session` and `/close-session` add the extras as
`pr_links:` / `tickets:` lists alongside these primaries — do not pre-write empty list keys here.

## Step 6.5 — Write real Goal and initial Next-steps plan

Read the notes you just created. **DO NOT leave `<fill in>` placeholders.** Rewrite:
- **Goal**: a single line capturing what was asked (the real why), in plain English.
- **Next steps**: a todo-list (`- [ ]` items), 3–7 items, one line each. Concrete: what comes next (not general advice). Mark any already-done items as `- [x]`.

Both are mandatory — stop and ask the user if the task is unclear. If you can infer the real goal from the context, write it yourself (don't push it to the user later).

Use the Edit tool to replace the `<one-line why — FILL IN>` and the `- [ ] …` Next steps.

## Step 7 — Register in active-sessions.json

> **Skip this step** if Step 4.5's collision guard fired and the user chose "New session in a fresh terminal" — the workspace stays unbound (empty `session_id`) until `/restart-session` opens it elsewhere.

```bash
python3 - <<EOF
import json, os
path = os.path.expanduser('~/.claude/active-sessions.json')
data = {}
if os.path.exists(path):
    try: data = json.load(open(path))
    except: data = {}
data['$SESSION_ID'] = {
    'notes_path': '$NOTES_PATH',
    'category': '$CATEGORY',
    'ticket': '${TICKET}',
    'name': '$NAME',
    'started_at': '$NOW'
}
tmp = path + '.tmp'
json.dump(data, open(tmp, 'w'), indent=2); os.replace(tmp, path)
EOF
```

## Step 8 — Git sync (only if in a repo)

```bash
if git rev-parse --git-dir >/dev/null 2>&1 && [ -n "$BRANCH" ]; then
  git fetch --all --prune || echo "WARN: fetch failed"
  if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
    if ! git rebase "origin/$BRANCH"; then
      git rebase --abort
      echo "WARN: conflicts rebasing on origin/$BRANCH — aborted, resolve manually"
    fi
  fi
  default=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
  [ -z "$default" ] && default=main
  if [ "$BRANCH" != "$default" ]; then
    if ! git rebase "origin/$default"; then
      git rebase --abort
      echo "WARN: conflicts rebasing on origin/$default — aborted, resolve manually"
    fi
  fi
fi
```

Never use `--force`, `--no-verify`, or `--skip`. If it conflicts, abort and let the user resolve.

## Step 9 — Rename the session

> **Skip this step** if Step 4.5's collision guard fired and the user chose "New session in a fresh terminal" — do not rename the current terminal, it still belongs to its existing session.

```bash
NEW_NAME="$CATEGORY | $NAME"
[ -n "$TICKET" ] && NEW_NAME="$NEW_NAME | $TICKET"
python3 - <<EOF
import json, os, glob
session_id = '$SESSION_ID'
new_name = """$NEW_NAME"""
for f in glob.glob(os.path.expanduser('~/.claude/sessions/*.json')):
    try:
        data = json.load(open(f))
        if data.get('sessionId') == session_id:
            data['name'] = new_name
            json.dump(data, open(f, 'w'), indent=2)
            print(f"Renamed session to: {new_name}")
            break
    except Exception:
        pass
else:
    print(f"WARN: could not find session file for {session_id} — rename manually: /rename {new_name}")
EOF
```

## Step 11 — Final output

Print a short summary: notes.md path · Goal (one line) · Next steps (count) · branch · git-sync result · renamed-to (or
`/rename …` fallback). The Goal + Next steps are now locked in.
