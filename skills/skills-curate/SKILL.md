---
name: skills-curate
description: >-
  Periodic curation pass over the skill collection — refreshes usage from the transcripts,
  reports the active/stale/archived state machine, and looks for clusters that should be
  ONE skill with labelled subsections instead of N near-siblings. Every outcome is a STAGED
  proposal for /skills-review; nothing is ever deleted, and only agent-proposed skills are
  moved. Trigger on "/skills-curate", "curate the skills", "cure les skills", "on a trop de
  skills qui se recoupent".
allowed-tools: Bash Read Write Edit
argument-hint: "[--include-mine]"
---

# /skills-curate — the anti-inflation pass

Skill inflation is not prevented at creation time — that is the wrong place, because at
creation you only see the one skill in front of you. It is prevented by a **periodic pass
over the whole collection**, which is the only vantage point from which a *cluster* is
visible. (This mirrors Hermes' `agent/curator.py`, which runs the same job in a forked
background agent.)

Two judgements, kept strictly apart — conflating them is the classic mistake:

| Question | Decided by | Where |
|---|---|---|
| Is this skill dormant? | **usage data**, never opinion | the state machine, Step 1 |
| Do these skills overlap? | **content**, never usage counts | your reading, Step 2 |

## Hard rules — do not violate

1. **Never delete.** The maximum destructive action is *archiving* — moving the directory
   to `~/.claude/skills/.archive/`. Archives are recoverable; deletion is not.
2. **Only ever act on `agent-proposed` skills** (`origin: agent-proposed` in the
   frontmatter). Hand-written skills are the user's own work: you may *report* that they
   form a cluster, never stage a move for them. Harness- and plugin-provided skills
   (`plugin:skill`, `loop`, `simplify`…) are externally owned — invisible to you.
3. **Everything is staged.** Write proposals to `~/.claude/skills-pending/`; only
   `/skills-review` may touch `~/.claude/skills/`. That includes archiving.
4. **Never stage a move for a skill something else depends on** — see Step 3.
5. **Usage counters justify neither a merge nor a prune.** `use_count: 0` is *absence of
   evidence*, not evidence of uselessness: a recent skill may simply not have met its
   trigger yet. Judge overlap on content alone.

## Step 0 — Mode check

If plan mode is active (a `Plan mode is active` system reminder is present): stop and print:

> ⚠️ Plan mode is active — this skill writes files and will be blocked.
> Switch to auto mode, then re-run `/skills-curate`.

## Step 1 — Refresh usage, then read the state machine

```bash
python3 ~/.claude/skills/lib/skill_usage.py scan
python3 ~/.claude/skills/lib/skill_usage.py report
python3 ~/.claude/skills/lib/skill_usage.py candidates    # add --include-mine if asked
```

`scan` is incremental (unchanged transcripts are skipped), so this is cheap after the
first pass. The state machine is `active` → `stale` (30 d) → `archived` (90 d), anchored on
real activity, with a grace floor for never-used skills.

The state is **information, not an instruction**: a `stale` agent-proposed skill is a
*candidate* for archiving, and only when its content is also obsolete or fully absorbed
elsewhere. Never stage an archive on the state alone.

## Step 2 — Look for clusters (the content judgement)

Take the candidate list. **Group by prefix / domain keyword** — `pr-*`, `funda-*`,
`vespa-*`, `session-*`. For each group with 2+ members, do **not** ask "are these two
overlapping?".

**Pairwise distinctness is the wrong bar.** "Each has a different trigger" is nearly
always true and nearly always irrelevant — it is exactly how a collection grows forty
near-siblings.

**The right bar:** *what umbrella class do these skills serve — and would a human
maintainer write this as N separate skills, or as ONE skill with N labelled subsections?*
When the answer is the latter, consolidate. Three ways, pick per cluster:

- **(a) Merge into an existing umbrella** — one member is already broad enough. Stage a
  **patch** adding a labelled subsection per sibling's unique insight, plus an **archive**
  proposal for each absorbed sibling.
- **(b) Create a new umbrella** — no member is broad enough. Stage a **new skill**
  proposal covering the shared workflow with short labelled subsections, plus archive
  proposals for the absorbed siblings.
- **(c) Demote to a support file** — a sibling holds narrow but valuable detail. Stage it
  as `references/<topic>.md` (session-specific detail, knowledge banks),
  `templates/<name>.<ext>` (files meant to be copied) or `scripts/<name>.<ext>`
  (re-runnable actions) under the umbrella, then archive the sibling.

**The name is a tell.** A skill whose name carries a ticket number, a codename, an error
string, or reads like a session artefact (`audit-…`, `salvage-…`, `fix-…-2026`) almost
always belongs as a subsection under a class-level skill.

**Iterate.** After one consolidation, re-scan the remaining set for the next umbrella.
Do not stop at the first.

### Package integrity — not optional

A skill is a **directory**, not a file. Before staging a demotion or an archive, check for
`references/`, `templates/`, `scripts/`, `assets/` and for relative links inside
`SKILL.md`:

```bash
ls -A ~/.claude/skills/<name>/
grep -nE '(references|templates|scripts|assets)/' ~/.claude/skills/<name>/SKILL.md
```

If it has support files or such links, do **not** flatten `SKILL.md` alone into the
umbrella's `references/`. Choose one of: keep it standalone · re-home *every* support file
into the umbrella **and** rewrite the paths in the destination text · archive the whole
package unchanged. Never leave instructions pointing at files left behind.

## Step 3 — Dependency check before staging any archive

A skill can be load-bearing for something outside the skill system. Check all three, and
skip any skill that is referenced:

```bash
NAME=<candidate>
# 1. launchd jobs (scheduled routines that invoke a skill by name)
grep -rl "$NAME" ~/Library/LaunchAgents/ 2>/dev/null
# 2. other skills, and the user's global instructions
grep -rln "$NAME" ~/.claude/skills/*/SKILL.md ~/.claude/CLAUDE.md 2>/dev/null | grep -v "/$NAME/"
# 3. the app's config (a category or flag may name it)
grep -l "$NAME" ~/.config/ai-agents-orchestrator/config.json 2>/dev/null
```

A referenced skill may still be **consolidated** — but then the reference has to move with
it, so say so explicitly in the proposal. It must never be archived and left dangling.

## Step 4 — Stage the proposals

Patches and new skills use the formats in `/skill-propose` (Steps 3a / 3b). Archives get
their own file, `~/.claude/skills-pending/<name>.archive.md`:

```markdown
---
target: <skill slug>
kind: archive
origin: agent-proposed
proposed_at: <YYYY-MM-DD HH:MM>
absorbed_into: <umbrella slug, or empty when simply obsolete>
---

## Why
<Two lines. If absorbed_into is set, name the patch proposal that carries the content
into the umbrella — a reviewer must be able to confirm nothing is lost before the
sibling goes away.>

## Dependency check
<The result of Step 3: what references this, or "none found".>
```

`absorbed_into` is the difference between *consolidation* and *pruning*. Set it and the
reviewer knows the content survives elsewhere; leave it empty and they know the skill is
being dropped as obsolete. Never guess — the umbrella must already exist, or its creation
patch must be staged in the same pass.

## Step 5 — Report

- the state-machine summary (how many active / stale / archived, and which changed);
- each cluster found, with the umbrella you would name and which of (a)/(b)/(c) applies;
- what was staged, and what was skipped and why (`mine`, external, or a dependency);
- `Review with /skills-review.`

If nothing qualifies, say so in one line. A quiet pass over a healthy collection is the
expected outcome, not a failure.
