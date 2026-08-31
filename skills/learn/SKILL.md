---
name: learn
description: >-
  Use PROACTIVELY, the moment something durable is learned — do not wait for the session to
  end. Writes one atomic note straight into this space's knowledge notes: a preference or
  correction the user just stated, a fact about their environment or conventions, a gotcha
  whose workaround cost real time. Priority: preferences & corrections > environment facts >
  everything else. The test is "does this stop them repeating themselves?". Reusable
  *procedures* belong in a skill (/skill-propose), not here. Trigger on "/learn", "remember
  that", "note ça", "mets ça dans le vault" — and just as much on the user's own words
  landing a preference or correction with no slash command at all: "always"/"toujours",
  "never"/"jamais", "I prefer"/"je préfère", "don't ... anymore"/"ne ... plus", "from now
  on"/"à l'avenir", "next time"/"la prochaine fois". That phrasing is the signal, not a
  literal command — check it on every turn, not only when asked.
allowed-tools: Bash Read Write Edit
argument-hint: "[what to record]"
---

# /learn — write it down now, not at the end

The knowledge notes only hold what somebody wrote into them. Waiting for `/close-session`
means the write depends on a gesture that often never comes — and a session that is never
closed teaches nothing to the next one. **This skill writes immediately.**

It is the *declarative* half of the pair: `/learn` records **what is true**, and
`/skill-propose` records **how to do something**. A repeatable procedure is a skill, not a
note.

## Step 1 — Is it worth a note?

Write only what a *future, different* session would be glad to find. In priority order:

1. **A preference or a correction the user just stated.** The strongest kind — it encodes a
   constraint you did not know and would otherwise breach again.
2. **A stable fact about their environment or conventions** — a tool quirk, a naming rule, a
   thing that is set up a particular way for a reason.
3. **A gotcha with its workaround** — where the naive approach fails, and what works
   instead. Keep the failure, not just the fix: that is the part nobody rediscovers.

**Skip** (this list is what keeps the notes worth searching):

- Anything trivial, obvious, or cheaply re-discovered by reading the code.
- Task progress, completed-work logs, "what we did today" — that is `notes.md`'s job.
- Temporary state: a red build, an open branch, a TODO.
- Raw dumps. A note is a claim, not a transcript.
- **A reusable procedure** → `/skill-propose` instead.

The one-line test: *does writing this stop the user having to say it again?* If not, skip,
and say so in one line rather than manufacturing a note.

## Step 2 — Resolve this space's knowledge notes

Never hardcode a path or a space name.

```bash
LIB="$HOME/.claude/skills/lib/aoconfig.py"
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
e = reg.get(sid) or {}
print((e.get('category') or '').strip() + '|' + (e.get('notes_path') or ''))
PY
)
NOTES_PATH="${CATEGORY#*|}"; CATEGORY="${CATEGORY%%|*}"
VAULT=$([ -n "$CATEGORY" ] && python3 "$LIB" vault "$CATEGORY" || python3 "$LIB" vaults | head -1)
```

`$VAULT` empty → no knowledge notes configured for this space. Say so once, suggest
*Settings → General → Spaces*, and stop. Do not silently drop what was learned.

## Step 3 — Extend an existing note before creating a new one

This is what keeps the notes searchable. A fifth note on the same subject does not add
knowledge, it dilutes retrieval.

```bash
python3 "$HOME/.claude/skills/lib/route_search.py" notes "<the key nouns>" "$VAULT"
```

- **A note already owns this subject** → `Read` it and **extend** it: add the new fact, or
  correct it if what you learned contradicts it. Bump `updated:`. A correction is worth more
  than a new note — a wrong note misleads every future session until someone fixes it.
- **Nothing owns it** → write a new one (Step 4).

## Step 4 — Write the note

**First, does this vault document its own schema?** A `README.md` or `CONVENTIONS.md` at
its root is the user's own contract — read it and follow it, including its frontmatter keys
and its folder names. A note that ignores the schema it lives in is a note the next search
ranks wrong. Only fall back to the shape below when there is nothing to follow.

Same shape the other skills read and write, so `/route` finds it and the vault stays one
coherent set:

```yaml
---
id: <YYYYMMDD-HHmm now>
title: <8–12 words, the claim itself — not "notes about X">
type: finding      # or concept / decision / gotcha / preference
status: active
created: <today>
updated: <today>
tags: [<2–3>]           # free-form, plural, kebab-case
projects: [<repo or project slug>]   # omit when it belongs to no project
session: <CATEGORY/slug, or the session id when unregistered>
origin: learn-in-flight
mocs: []                # the Maps of Content this belongs under, when the vault keeps any
related: []             # wikilinks to the notes this one builds on
---

<One paragraph, context-free: the claim, then WHY it holds. A note that says "do X"
ages badly; "do X because Y fails when Z" survives.>
```

Write to `<VAULT>/20-Notes/<id>-<kebab-title>.md` when that directory exists, else to the
vault root — the layout is the user's, not ours.

Fill `related:` with the notes you read in Step 3 that this one builds on, even when you
did not extend them — a note nothing points at is reachable only by full-text luck, which
is the failure the links exist to prevent.

Then **link it in**, or it is invisible: prepend a row to `## Recently added` in
`<VAULT>/INDEX.md` — `| <today> | [[<id>-<slug>]] | <tags> |`, newest first. An orphan note
is one nobody finds; that failure mode is real and silent.

## Step 5 — Say it out loud, in one line

There is deliberately **no approval gate** — a prompt at every insight would kill the point
of writing in flight. The safeguard is visibility instead: always report it, one line, so a
wrong note gets corrected the moment it is written rather than misleading a session in three
months.

```
Learned → <title>  (<VAULT>/20-Notes/<id>-<slug>.md)
```

Say "extended `<existing note>`" when that is what happened. Never claim to have written
something you did not.
