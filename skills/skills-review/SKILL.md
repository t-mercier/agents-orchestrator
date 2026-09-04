---
name: skills-review
description: >-
  Review staged skill proposals from ~/.claude/skills-pending/ — list them, show the full
  content or a real diff, then approve (promote into ~/.claude/skills/) or reject. The ONLY
  path by which a proposed skill becomes active. Also reports when the learning loop last
  produced anything, so a silently dead loop is visible. Trigger on "/skills-review",
  "review pending skills", "revois les skills proposées", "/skills-review approve <name>".
allowed-tools: Bash Read Write Edit AskUserQuestion
argument-hint: "[list | show <name> | approve <name> | reject <name>]"
---

# /skills-review — the approval gate

Nothing in `~/.claude/skills-pending/` affects a session. This skill is the only way a
proposal becomes active, and it always shows the user what they are approving first.

Parse `$ARGUMENTS`: no args or `list` → Step 1. `show|diff <name>` → Step 2.
`approve <name>` → Step 3. `reject <name>` → Step 4.
Three proposal kinds exist: a new skill (a directory), a `*.patch.md`, and a
`*.archive.md` staged by `/skills-curate`.

## Step 1 — List what is pending

```bash
PEND=~/.claude/skills-pending
mkdir -p "$PEND"
# `find`, not a glob: the shell here is zsh, which ABORTS on a non-matching glob
# (nomatch) — and "nothing pending" is the normal case.
found=0
while IFS= read -r m; do
  found=1
  printf 'NEW    %-28s %s\n' "$(basename "$(dirname "$m")")" \
    "$(grep -m1 '^proposed_at:' "$m" | sed 's/proposed_at: //')"
done < <(find "$PEND" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null)
while IFS= read -r p; do
  found=1
  printf 'PATCH  %-28s %s\n' "$(basename "$p" .patch.md)" \
    "$(grep -m1 '^proposed_at:' "$p" | sed 's/proposed_at: //')"
done < <(find "$PEND" -mindepth 1 -maxdepth 1 -name '*.patch.md' 2>/dev/null)
while IFS= read -r a; do
  found=1
  printf 'ARCHIVE %-27s %s  absorbed_into=%s\n' "$(basename "$a" .archive.md)" \
    "$(grep -m1 '^proposed_at:' "$a" | sed 's/proposed_at: //')" \
    "$(grep -m1 '^absorbed_into:' "$a" | sed 's/absorbed_into: *//' | sed 's/^$/(none — pruned as obsolete)/')"
done < <(find "$PEND" -mindepth 1 -maxdepth 1 -name '*.archive.md' 2>/dev/null)
if [ "$found" = 0 ]; then echo "(nothing pending)"; fi   # `if`, not `&&`: a bare test
                                                        # returns 1 when items DO exist,
                                                        # failing the whole block
```

For each entry also print its one-line rationale — the `description:` for a new skill, the
`## Why` first line for a patch. The user should be able to triage from the list alone.

### Loop health

A learning loop that quietly stopped firing is worse than no loop, because you believe it
is working. Always end the listing with:

Read the **frontmatter only**. A plain `grep` over the file matches the skills that document this line
inside a fenced example (`skills-curate`, `skill-propose`) and then reports their template placeholder
as a date:

```bash
# awk prints only the lines between the first pair of --- markers.
LAST=$(for f in ~/.claude/skills/*/SKILL.md; do
         awk '/^---[[:space:]]*$/{n++; next} n==1' "$f" 2>/dev/null \
           | grep -q '^origin:[[:space:]]*agent-proposed' && echo "$f"
       done | xargs -r ls -t 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
  echo "Last approved new skill: $(awk '/^---[[:space:]]*$/{n++; next} n==1' "$LAST" \
       | grep -m1 '^proposed_at:' | sed 's/proposed_at: *//') ($(basename "$(dirname "$LAST")"))"
else
  echo "No agent-proposed skill has ever been approved."
fi
echo "(patches are not counted here — see ~/.claude/skills-applied.log)"
# Not `grep ... | tail -3 || echo`: a pipeline takes tail's status, which is 0 even on
# empty input, so the fallback would never fire. Capture first, then test.
ENTRIES=$(grep '^===' ~/.claude/skills-applied.log 2>/dev/null | tail -3)
if [ -n "$ENTRIES" ]; then echo "$ENTRIES"; else echo "No patch has been applied since the log was introduced."; fi
```

The trailing lines matter: the scan above only ever sees **new skills**. Patches to existing skills
are the common outcome, and approving one removes the proposal file without marking the target, so a
run of approved patches still prints "never". Read a "never" as "no new skill", not as "the loop is
dead" — the log tells you whether patches have been landing.

An empty log next to skills that were clearly patched means the patches predate the log, or an
install overwrote them. Both are worth saying out loud rather than reporting "nothing pending".

If nothing has been proposed **or** approved in the last ~3 weeks of active work, say so
plainly and run both checks below — a loop that never fires almost always fails at one of
them, and neither is visible from the outside.

```bash
# 1. Is the gate on at all?
python3 ~/.claude/skills/lib/aoconfig.py flag skillProposals    # must print: on

# 2. Do the INSTALLED session skills actually carry the proposal step? An installer run
#    without --force keeps an existing skill untouched, so a repo pull delivers the new
#    skills and the libs but leaves close-session/save-session on their old copy — the
#    flag then reads `on` while nothing can ever fire.
for s in close-session save-session; do
  grep -q skillProposals ~/.claude/skills/$s/SKILL.md 2>/dev/null \
    || echo "MISSING: /$s has no proposal step — its installed copy predates this feature"
done
```

If check 2 reports anything, the fix is a force install:
`bash scripts/install.sh --force`, or **Settings → Session skills → Install / update**.
Say so explicitly rather than reporting "nothing pending" — the two look identical to the
user and mean completely different things.

## Step 2 — Show it

**A new skill** → print the whole `SKILL.md`. It is short by construction; the user reads
all of it. Flag anything that deserves a second look: shell commands with side effects,
absolute paths, anything resembling a credential.

**A patch** → show a *real* diff, not the proposal's prose. One command does the parse,
the anchor check and the diff, so what is displayed is exactly what approval would write:

```bash
python3 ~/.claude/skills/lib/patch_apply.py diff ~/.claude/skills-pending/<name>.patch.md
```

If an `old_string` no longer matches (the target changed since the proposal), STOP and
report it as stale — do not guess a new anchor. Suggest rejecting and re-proposing.

## Step 3 — Approve

Always show the content or diff (Step 2) **before** asking, then confirm with
`AskUserQuestion`. Never approve implicitly, even when `approve <name>` was passed
explicitly — the user asked to approve a name, not sight-unseen content.

**New skill:**

```bash
SRC=~/.claude/skills-pending/<name>
DST=~/.claude/skills/<name>
[ -e "$DST" ] && { echo "ERROR: $DST already exists — this is a patch, not a new skill."; exit 1; }
mv "$SRC" "$DST"
```

Keep the `origin: agent-proposed` / `source_session:` / `version:` frontmatter — that
provenance is what lets you tell later what you wrote yourself and what was proposed.

**Archive** (staged by `/skills-curate`): move the directory aside — never delete it.

```bash
NAME=<name>
mkdir -p ~/.claude/skills/.archive
mv ~/.claude/skills/"$NAME" ~/.claude/skills/.archive/"$NAME"
rm -f ~/.claude/skills-pending/"$NAME".archive.md
```

Two checks first, and refuse if either fails:

- **`absorbed_into` is set** → the umbrella must already contain the content. Confirm the
  companion patch was approved (or approve it first). Archiving a sibling before its
  content lands elsewhere loses it.
- **The `## Dependency check` section says something is referencing it** → do not archive.
  Fix the reference first, or keep the skill.

**Patch:** apply it with the tool, never by hand — it re-checks the anchors at write time
and writes atomically:

```bash
LOG=~/.claude/skills-applied.log
PATCH=~/.claude/skills-pending/<name>.patch.md
# Capture the diff BEFORE applying. Afterwards the anchors no longer match and
# `patch_apply.py diff` refuses, so there would be nothing left to record.
DIFF=$(python3 ~/.claude/skills/lib/patch_apply.py diff "$PATCH")
python3 ~/.claude/skills/lib/patch_apply.py apply "$PATCH"
{ printf '=== %s  patch  %s\n' "$(date +'%Y-%m-%d %H:%M')" "<name>"; echo "$DIFF"; echo; } >> "$LOG"
rm -f "$PATCH"
```

`~/.claude/skills-applied.log` is append-only and is the ONLY record that a patch was ever
applied — approval deletes the proposal, and the target file carries no marker. Its job is
recovery: an installer run, a plugin update or an app reinstall overwrites a bundled skill
with the upstream copy and silently drops the patch, and without this log there is no way
to know what was lost, let alone replay it. Never rewrite or prune it.

Then bump the target's `version:` patch number if it has one (some hand-written skills
carry no frontmatter at all — leave those alone). If the target has no `origin:` field (a
hand-written skill), leave it absent — do not relabel the user's own work as
agent-proposed; note in the report that a hand-written skill was patched.

Then verify and report: re-read the promoted file, confirm the change is in, print the
path. If the target is a skill bundled in a repo (e.g. the session skills in
`ai-agents-orchestrator`), say so — the repo copy will now differ from the installed one
and needs the same edit, or a `--force` install will silently revert it.

## Step 4 — Reject

Confirm, then remove. Rejection is information: record one line of *why* in the current
session's `notes.md` under `## Decisions made`, so the same proposal is not re-staged next
week for the same reason.

```bash
rm -rf ~/.claude/skills-pending/<name>            # new skill
rm -f  ~/.claude/skills-pending/<name>.patch.md    # patch
rm -f  ~/.claude/skills-pending/<name>.archive.md  # archive
```
