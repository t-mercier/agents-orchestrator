---
name: wrap-session
description: >-
  Wrap up a session UNATTENDED — the headless twin of /close-session, run by the
  dashboard's Close button. Summarises the conversation into the notes.md it is given,
  refreshes the PR / ticket frontmatter, and stamps the Session history entry that marks
  the session Closed. Asks nothing, distils nothing, proposes nothing. Trigger on
  "/wrap-session <notes_path> <session_id>".
allowed-tools: Bash Read Edit
argument-hint: "<notes_path> <session_id>"
---

# /wrap-session — wrap up, and only that

`/close-session` run without a human in front of it. It exists because the dashboard's
**Close** button wraps a stale session without opening a terminal: the app resumes the
session with `--print`, which means **nothing can answer a question**. So this skill asks
none, and does only what a wrap-up strictly is — steps 1 to 6 of `/close-session`.

Deliberately NOT here: the knowledge-notes distil and the skill proposal. Those are
judgement calls that deserve a human, and they stay in `/close-session`, which you run
yourself.

## Arguments (both required)

```
/wrap-session <notes_path> <session_id>
```

**Take both from the arguments. Never resolve them yourself.** `--resume` runs the
conversation under a NEW session id, so the usual pid/registry lookup would find this
headless process rather than the session being wrapped, and the close marker would point
at an id that no one can resume. `<session_id>` is the ORIGINAL session — the one whose
conversation you are reading right now.

Missing argument, or `<notes_path>` is not an existing file → print one line saying so and
stop. Do not guess a path: the wrong notes.md would be overwritten with another session's
summary.

## Step 1 — Read the notes

Read `<notes_path>`. Note `category`, `ticket`, `name`, `branch` from the frontmatter.

## Step 2 — Build the summary (from THIS conversation)

The conversation was restored by `--resume`, so it is the session's real history. Gather:

- **Decisions made** — date-prefixed (`YYYY-MM-DD:`) one-liners (architecture/approach choices).
- **Files touched** — paths + a one-line note (pull from Edit/Write calls).
- **Open questions** — tick off any now-resolved `[ ]`; append genuinely new ones.
- **Next steps** — `- [ ]` items, ≤7 open, one line each. Completed work becomes `- [x]`, never deleted.
- **One-line summary** — a concrete result in past tense, 10–15 words (not "worked on X").

Skip noise (don't list every read/grep).

## Step 3 — Frontmatter refresh (append-only)

A session can reference several PRs and tickets, held as a primary value plus a list of
extras. **Append only** — never remove a link, never overwrite a value with empty:

```yaml
pr_link: https://github.com/o/r/pull/12    # primary — shown on the card
pr_links:
  - https://github.com/o/r/pull/15
ticket: FEAT-1842
tickets:
  - FEAT-1877
```

Collect every PR URL this session is about:

- `gh pr view --json url -q .url` on the session's branch. A valid
  `https://github.com/owner/repo/pull/N` → use it.
- The PRs created or handled in THIS conversation (scan it) — `gh` only ever reports the
  current branch's, so this is how a session's *other* PR is found.

Add any URL not already present, keeping the existing primary as the primary. Same for
tickets matching `^[A-Za-z][A-Za-z0-9]*-[0-9]+$`, uppercased.

Record each ticket's status too, when this session actually saw one — a tracker lookup, a
status you were told, a transition you performed. Never invent one, and never leave an
entry you now know is wrong: an out-of-date status shown as current is worse than none.

```yaml
ticket_states:                             # one entry per ticket, the tracker's own words
  - GOSDK-201341: In Review
```

If `ticket:` was empty and you just filled it, patch `~/.claude/active-sessions.json` for
`<session_id>` by **merging**: set `ticket` only, preserving `notes_path`, `category`,
`name`, `started_at`. The registry mirrors the primary ticket alone.

## Step 4 — Update the notes.md sections

With the Edit tool: append to **Decisions made** and **Files touched**, update **Open
questions** (tick resolved, add new), replace **Next steps**.

## Step 5 — Stamp the Session history (ALWAYS — this is the close marker)

```bash
NOW=$(date +"%Y-%m-%d %H:%M")
```

Append under `## Session history`:

```
- <NOW> | session=<session_id> | <one-line summary>
```

`<session_id>` is the **argument**, not the id of this headless run — the line has to name
the session someone would resume.

This line is what moves the session to **Closed**. Always write it, even when nothing new
happened (`reclosed — no new work since the last close`). Only skip it when the latest
entry is already a close dated **today**.

## Step 6 — Confirm in one line

Print what changed: sections updated, links attached, the history line written. The app
shows this back to the user, so keep it to a single line.

If you got this far without writing the Session history entry, say so explicitly — the app
falls back to stamping a plain close marker itself, and it needs to know it must.
