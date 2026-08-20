---
name: sync-refs
description: >-
  Bring a session's tickets and pull requests back in line with reality — run UNATTENDED by
  the dashboard's Sync button. Reads the tracker for each ticket's current status and asks
  `gh` for the pull requests that belong to this session's work, then rewrites the
  frontmatter. Touches nothing else. Trigger on "/sync-refs <notes_path>".
allowed-tools: Bash Read Edit
argument-hint: "<notes_path>"
---

# /sync-refs — realign a session's tickets and PRs

The dashboard's **Sync** button, run with `--print`, so **nothing may ask a question**.

It exists because two facts drift on their own: a ticket's status changes in the tracker,
and a pull request gets opened long after the session's notes were last written. The app
cannot read either — it holds no tracker credentials, and it does not know which branches
belong to a session. An agent does, through MCP and `gh`.

Deliberately NOT here: summarising, closing, distilling, editing prose. This rewrites two
frontmatter keys and stops.

## Arguments

```
/sync-refs <notes_path>
```

`<notes_path>` is not an existing file → print one line saying so and stop. Never guess a
path: the wrong notes.md would be rewritten with another session's references.

## Step 1 — Read the frontmatter

Read `<notes_path>` and note:

- `ticket:` + `tickets:` — every ticket this session is about.
- `ticket_states:` — what we believed last time.
- `pr_link:` + `pr_links:` — the pull requests already attached.
- `branch:` — the branch last recorded, useful but not authoritative.

No tickets and no PRs → nothing to sync. Say so in one line and stop.

## Step 2 — Ticket statuses, from the tracker

For each ticket, fetch its **current status** through the Atlassian MCP tools (or whichever
tracker MCP is configured). Use the tracker's own wording — `Ready For Review`, `Triaged`,
`Aborted` — never a normalised version of it: the dashboard derives its colour from the
word but shows the word itself, and a project's vocabulary is the useful part.

Rewrite `ticket_states:` in full:

```yaml
ticket_states:
  - GOSDK-201341: Ready For Review
  - GOSDK-221110: Aborted
```

**Replace, do not append.** A status is a snapshot, and this is exactly the key whose stale
value is worse than none — an old "Triaged" shown as current is what makes the board lie.
Drop the entry for a ticket the tracker cannot answer for, rather than keeping the last
known value.

If no tracker MCP is available, leave `ticket_states:` **untouched** and say so in the
confirmation. Silently wiping the statuses because a tool was missing would look like every
ticket lost its status.

## Step 3 — Pull requests, from `gh`

A session's PRs are the ones whose branch names one of its tickets — that is the convention
the branches follow (`fix/GOSDK-221743-…`, `test/GOSDK-201341-…`).

Search each repository that already appears in `pr_link:` / `pr_links:`; that is how the
repo is known without guessing. With no PR attached yet, use the git repository of the
current directory if it is one, and otherwise skip this step.

```bash
gh pr list --repo <owner/repo> --state all --limit 60 --json number,url,headRefName,title
```

Keep a PR when its `headRefName` contains one of the session's ticket ids. Add every one
not already listed, keeping the existing `pr_link:` as the primary — a session's first PR
stays its headline — and writing the rest as `pr_links:` entries.

**Append only. Never remove a PR link**, whatever `gh` says: a link the user attached by
hand is a deliberate act, and a branch can be deleted while its PR still matters. Pruning
is the dashboard's editor, on purpose.

## Step 4 — Confirm in one line

Print what changed: how many ticket statuses were refreshed, which PRs were newly attached,
or that nothing moved. **In English**, whatever language the surrounding session uses — this
line is app UI, not conversation. One line: the app shows it as-is.

Worth flagging when it happens: a ticket the tracker redirected to another key (a moved
project). Name both keys — the status is real but it no longer belongs to the id in the
notes, and only the user can decide what to do about that.
