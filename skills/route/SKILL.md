---
name: route
description: >-
  Use BEFORE investigating a bug, a ticket or an unfamiliar area — surfaces what past
  sessions already established so you do not re-derive it from the code. Builds a Context
  Brief from this space's knowledge notes, your past session notes, and (if a tracker is
  reachable) its tickets. Read-only. Trigger on "/route", "context brief", "have we worked
  on this before?", or proactively at the start of any debugging or implementation task.
allowed-tools: Bash Read
argument-hint: "<ticket | topic | error string>"
---

# /route — a Context Brief before you dig

**Run this before opening the code, not after getting stuck.** What a past session
concluded is invisible from the repo: a decision that took an afternoon leaves no trace in
the source, and a conclusion three months old is not something you will re-derive by
reading files.

Read-only. It never writes.

## Step 0 — The query

`QUERY` = everything after `/route`, trimmed. Empty → print the usage line and stop.

## Step 1 — Resolve which notes to read, from the session's SPACE

A space's knowledge notes are configured per space, so the folder to read depends on where
this session lives. Resolve it — never hardcode a path, and never hardcode a space name:
users name their own spaces.

```bash
LIB="$HOME/.claude/skills/lib/aoconfig.py"

# Is this terminal a managed session? Its category names its space, which names its notes.
CATEGORY=$(python3 - <<'PY'
import glob, json, os, subprocess
def ancestors(pid):
    seen = set()
    while pid > 1:
        try:
            pid = int(subprocess.run(['ps', '-p', str(pid), '-o', 'ppid='],
                                     capture_output=True, text=True).stdout.strip())
            seen.add(pid)
        except Exception:
            break
    return seen
mine = ancestors(os.getpid())
sid = ''
for f in sorted(glob.glob(os.path.expanduser('~/.claude/sessions/*.json')),
                key=os.path.getmtime, reverse=True):
    try:
        if int(os.path.basename(f)[:-5]) in mine:
            sid = (json.load(open(f)) or {}).get('sessionId', '')
            if sid:
                break
    except Exception:
        pass
try:
    reg = json.load(open(os.path.expanduser('~/.claude/active-sessions.json')))
except Exception:
    reg = {}
print(((reg.get(sid) or {}).get('category') or '').strip())
PY
)

if [ -n "$CATEGORY" ]; then
  VAULTS=$(python3 "$LIB" vault "$CATEGORY")      # this space's notes
else
  VAULTS=$(python3 "$LIB" vaults)                 # unmanaged terminal → read them all
fi
```

**Always report which folder was read and why** — "this session's space" or "all of them,
this terminal is unmanaged". A brief that silently searched the wrong space is worse than
no brief.

`$VAULTS` empty means no knowledge notes are configured (`knowledge.enabled`, and a
`vaultPath` on the space). Say so plainly and continue with Step 3 — past session notes
are still worth searching.

## Step 2 — Search the knowledge notes

```bash
SEARCH="$HOME/.claude/skills/lib/route_search.py"
echo "$VAULTS" | while IFS= read -r V; do
  [ -n "$V" ] || continue
  python3 "$SEARCH" notes "$QUERY" "$V"
  python3 "$SEARCH" areas "$QUERY" "$V"
done
```

The search discovers the layout: a vault organised as `20-Notes/` · `10-Areas/` is used as
such, anything else is scanned as a flat folder of Markdown. Pass the query as an
**argument** — an earlier version of this skill passed it through an environment variable
that nothing exported, so every search silently matched nothing.

Then read the top matches in full (`Read`). The one-line titles are for ranking; the
conclusion you need is in the body.

## Step 3 — Search past session notes

```bash
python3 "$HOME/.claude/skills/lib/route_search.py" sessions "$QUERY"
```

Scoped to the configured roots, two levels deep — session notes live at
`<root>/<CATEGORY>/<slug>/notes.md`, and going deeper only crawls checked-out repos.

A match is a past session on this subject: read its `notes.md` for the decisions and the
next steps it left behind.

## Step 4 — Optional: the ticket tracker

Only when a tracker is reachable (an MCP server, or a CLI). Skip silently otherwise.

The knowledge notes and the session notes only cover work that went through a managed
session. A ticket you merely **commented on** or triaged leaves no trace in either — the
tracker is the only place it exists.

If that tracker is **Jira**, three traps, in the order you hit them:

1. **Do not filter on identity first.** `assignee` / `reporter` / `watcher = currentUser()`
   miss every ticket you only commented on, and JQL has no "commented by" field — which is
   exactly the triage case.
2. **Do not run a broad `text ~` search.** The response blows the tool-result limit, lands
   in a file, and costs a round-trip to read back. Search `summary` first.
3. **Reduce the fields.** `summary,status,updated,project,assignee,reporter` is enough to
   scan; everything else inflates the response without helping.

The query that works — the domain nouns, no identity filter:

```
(summary ~ "<noun>" AND (summary ~ "<adjective1>" OR summary ~ "<adjective2>"))
ORDER BY updated DESC
```

Then, on the candidates, fetch the issue **with its comments** — the conclusion (root
cause, screenshot, the ticket that fixed it) is almost always in a comment, not the
description. Ask for `parent` too: a subtask describes the symptom, its parent carries the
architecture and scope, and therefore which code path applies.

## Step 5 — Assemble the brief

```
## Context Brief — <QUERY>

Read from: <which notes folder, and why>

**Knowledge notes:**       <matches from Step 2, with the conclusion, not just the title>
**Past sessions:**         <matches from Step 3 — category/slug, ticket, date, what it settled>
**Tracker:**               <Step 4, with the conclusion drawn from the comments>
**Suggested entry points:** <files or areas the matches point at>
```

**Never return an empty brief.** With no match, say the notes are cold on this subject and
still give a starting point — the closest area, the most likely repo, and the fact that
this looks like new ground. "Nothing found" is itself useful: it means no past session
solved this, so you are not about to duplicate work.
