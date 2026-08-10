---
name: save-session
description: >-
  Checkpoint the active session WITHOUT closing it: resolve its registered notes.md,
  summarise what this session did so far (Decisions, Files touched, Open questions,
  Next steps), update those sections, and append an "(in progress)" Session history
  entry. The session stays open. Useful mid-session, or right before context compaction.
  Trigger on "/save-session", "save session", "checkpoint", "sauvegarde la session".
allowed-tools: Bash Read Edit Write
argument-hint: ""
---

# /save-session — checkpoint the active session (stays open)

Persists what's been learned/decided so far into `notes.md` without ending the session —
so nothing is lost to context compaction. Unlike `/close-session`, it marks the entry
`(in progress)` and does NOT wrap the session up.

## Step 0 — Mode check

If plan mode is active (a `Plan mode is active` system reminder is present): stop and print:

> ⚠️ Plan mode is active — this skill writes files and will be blocked.
> Switch to auto mode, then re-run `/save-session`.

## Step 1 — Resolve the current session ID

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
                print(sid); break
    except Exception:
        pass
")
```

## Step 2 — Find the registered notes.md

```bash
NOTES_PATH=$(python3 - "$SESSION_ID" <<'PY'
import json, os, sys
sid = sys.argv[1]
p = os.path.expanduser('~/.claude/active-sessions.json')
try: d = json.load(open(p))
except Exception: d = {}
print((d.get(sid) or {}).get('notes_path', ''))
PY
)

# Relink fallback: a RESUMED session's id is often absent from active-sessions.json (it
# was closed/archived → de-registered), but its managed notes.md still records the id as a
# `session=<id>` history line. Find that notes.md so the checkpoint lands in the RIGHT
# place instead of nowhere. Searches each configured category folder via aoconfig.
if [ -z "$NOTES_PATH" ] && [ -n "$SESSION_ID" ]; then
  while IFS= read -r cat; do
    [ -z "$cat" ] && continue
    base=$(python3 ~/.claude/skills/lib/aoconfig.py base "$cat" 2>/dev/null)
    [ -z "$base" ] && continue
    hit=$(grep -rl "session=$SESSION_ID" "$base"/*/notes.md 2>/dev/null | head -1)
    [ -n "$hit" ] && { NOTES_PATH="$hit"; break; }
  done < <(python3 ~/.claude/skills/lib/aoconfig.py categories 2>/dev/null)
fi
```

If `$NOTES_PATH` is empty: stop and tell the user there's no active session registered
for this conversation — run `/start-session` (new) or `/restart-session <slug>` (resume) first.

## Step 3 — Read the notes + frontmatter

Read `$NOTES_PATH`. Note its existing sections (Goal, Decisions made, Files touched,
Open questions, Next steps, Session history).

## Step 4 — Build the summary (from THIS conversation, so far)

From the work done in this session up to now, gather:
- **Decisions made** — date-prefixed (`YYYY-MM-DD:`) one-liners (architecture/approach choices).
- **Files touched** — paths + a one-line note (pull from Edit/Write calls).
- **Open questions** — tick off any now-resolved `[ ]`; append genuinely new ones.
- **Next steps** — a todo-list (`- [ ]` items, ≤7 open items, one line each). Mark completed work as `- [x]` (don't delete). Max 7 open items total.
- **One-line summary** — a concrete result in past tense, 10–15 words (not "worked on X").

Skip noise (don't list every read/grep). **Re-validate Goal** if it's drifted (rewrite in one line if needed).

## Step 5 — Frontmatter refresh (auto-attach PR / ticket)

A session can reference SEVERAL PRs and tickets — one task split across two PRs, or an
epic plus its sub-task. The frontmatter holds them as a primary value plus a list of
extras, and this step **APPENDS** to that list; it never replaces what's already there:

```yaml
pr_link: https://github.com/o/r/pull/12    # primary — shown on the card
pr_links:                                  # extras, in order (omit the key when there are none)
  - https://github.com/o/r/pull/15
ticket: FEAT-1842
tickets:
  - FEAT-1877
```

Collect every PR URL this session is about:
- Deterministic source: `gh pr view --json url -q .url` on the current branch (session's repo). A valid GitHub PR URL (`https://github.com/owner/repo/pull/N`) → use it.
- Also the PRs Claude created/manipulated in THIS conversation (scan it for GitHub PR URLs) — that's how the session's *other* PR is found, since `gh` only ever reports the current branch's.

Then, with the Edit tool: add any URL **not already** in `pr_link:` / `pr_links:`, keeping
the existing primary as the primary (a session's first PR stays its headline). Write extras
as `pr_links:` list items. NEVER remove a link and NEVER overwrite a value with empty — the
dashboard's PR editor is where links get pruned, deliberately.

Same for tickets matching `^[A-Za-z][A-Za-z0-9]*-[0-9]+$` created/identified in the session:
1. Uppercase them.
2. Add any that aren't already in `ticket:` / `tickets:` (primary first, extras as list items).
3. If `ticket:` was empty and you just filled it, patch `active-sessions.json` by reading the current entry for `SESSION_ID` and MERGING: set only `ticket`, preserve `notes_path`, `category`, `name`, `started_at` (do NOT replace the whole entry). The registry mirrors the PRIMARY ticket only — extras live in notes.md alone.

The dashboard's ticket / PR icons fill automatically once the frontmatter is right; with
several links they show a count badge and open a picker.

## Step 5b — Update notes.md sections

Use the Edit tool to: append new bullets to **Decisions made** and **Files touched**;
update **Open questions** (tick resolved, add new); replace **Next steps** with the
updated list.

## Step 6 — Append an "(in progress)" Session history entry

```bash
NOW=$(date +"%Y-%m-%d %H:%M")
```

Append under `## Session history` (Edit tool) — flagged **`(in progress)`** so the
dashboard keeps the session in Running (a checkpoint, NOT a close):

```
- <NOW> (in progress) | session=<SESSION_ID> | <one-line summary>
```

Do NOT write a close-style entry here — that's `/close-session`'s job. `/save-session`
only checkpoints; the session stays open.

## Step 6b — Optional: propose a skill from what this session taught (gated)

The procedural twin of the knowledge distil above: that one promotes *facts*, this one
promotes *how we got there*. Gated, so it is off unless explicitly enabled:

```bash
PROPOSE=$(python3 ~/.claude/skills/lib/aoconfig.py flag skillProposals)
```

**`$PROPOSE` empty** → skip **silently**. Do not mention it in the confirmation.

**`$PROPOSE` = `on`** → follow the `/skill-propose` skill against this session (its Steps
1–4). Do not restate its criteria here — that skill owns them. Two properties matter:

- It is **silent unless one of its four criteria actually fired**, so an ordinary session
  produces nothing. No proposal is the normal outcome.
- It **never writes into `~/.claude/skills/`**. Proposals are staged under
  `~/.claude/skills-pending/` and only `/skills-review` can promote them.

Mention a staged proposal in the confirmation (one line, with which criterion fired);
say nothing when there is none.

## Step 7 — Confirm

Print a short confirmation: frontmatter refresh result (PR link / ticket updated, or already set), which sections were updated + the `(in progress)` history
line added. Remind the user the session is still open — run `/close-session` when done,
or just keep working.
