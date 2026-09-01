---
name: skill-propose
description: >-
  Capture procedural knowledge as a STAGED skill proposal — a new skill, or a targeted
  patch to an existing one — written to ~/.claude/skills-pending/ and never to
  ~/.claude/skills/. Use PROACTIVELY, in flight: the moment the user corrects your
  approach, or the same output goes through a SECOND rewrite pass, stop and consider
  whether the skill that produced it is the defect. Do not wait for the session to close.
  Fires only when the session actually taught something reusable; stays silent otherwise.
  Review with /skills-review. Trigger on "/skill-propose", "propose a skill", "fais-en une
  skill", "capture ça en skill", "on pourrait pas améliorer la skill ?".
allowed-tools: Bash Read Write Edit
argument-hint: "[a hint about what to capture]"
---

# /skill-propose — stage a skill from what this session learned

Turns *how we got there* into a reusable skill. This is the **procedural** twin of the
knowledge distil: `/distil` promotes decisions and facts (declarative) to the notes, this
promotes workflows (procedural) to `skills/`.

**Two hard rules, no exceptions:**

1. **NEVER write to `~/.claude/skills/`.** A skill is an instruction that shapes every
   future session; a wrong one is a silent, persistent regression. Proposals go to
   `~/.claude/skills-pending/` and only `/skills-review` promotes them, after the user
   has read the diff.
2. **Stay silent when nothing qualifies.** A proposal at every invocation is how you end
   up with forty half-overlapping skills. If no criterion below fires, say so in one
   line and stop. That is a success, not a failure.

## Step 0 — Mode check

If plan mode is active (a `Plan mode is active` system reminder is present): stop and print:

> ⚠️ Plan mode is active — this skill writes files and will be blocked.
> Switch to auto mode, then re-run `/skill-propose`.

## Step 1 — Does anything qualify?

Look back over THIS session. A candidate exists only if at least one of these fired:

1. **A complex task succeeded** — roughly 5+ tool calls of real work, not a lookup.
2. **You hit errors or dead ends, then found the path that works.** The valuable part is
   the dead end, not the destination: "X looks right but fails because Y, do Z instead".
3. **The user corrected your approach.** The strongest signal there is — it encodes a
   preference or a constraint you did not know and would otherwise breach again.
   **Twice on the same artifact is the loudest version of it, and it does not wait for the
   session to end.** A second rewrite pass of one output means the first attempt followed
   the instructions available and was still wrong — so the instructions are what is
   missing. Say it at that moment, not at the close: three passes that end in a shrug teach
   nothing, and the user should not have to be the one to ask.
4. **You discovered a non-trivial workflow** — an ordering, a gate, a flag that is not
   discoverable from the code or the docs.

**Then find where the defect actually lives.** If the corrected output came from a skill,
that skill is the first suspect, and the proposal is a patch to it — not a new skill, and
not a note. Quote the passage that led you into the mistake and say what it fails to
cover: "outcome first" is not enough for a finding whose impact *is* the argument, and a
rule that is right but unreachable at the moment of writing is a rule that does not exist.
A skill that produced three rejected drafts and gets no patch will produce a fourth.

Then apply the **reusability test**, which overrides all four: would this help in a
*future, different* session? If it is specific to one repo's current state, it belongs in
that session's `notes.md`. If it is a fact rather than a procedure, it belongs in memory
or the vault. Only a repeatable *procedure* becomes a skill.

**Nothing qualified** → print one line ("Nothing worth a skill this session — <reason>.")
and stop. Do not manufacture a candidate.

## Step 2 — Patch an existing skill before creating a new one

This step is what keeps the skill set from inflating. List what already exists:

```bash
python3 - ~/.claude/skills/*/SKILL.md <<'PY'
import pathlib, re, sys
for a in sys.argv[1:]:
    p = pathlib.Path(a)
    # Most skills use a folded scalar (`description: >-`), so the text continues on the
    # following indented lines — a plain grep would only ever return ">-".
    m = re.search(r'^description:[ \t]*(.*?)(?=^[A-Za-z_-]+:|^---)', p.read_text(), re.M | re.S)
    d = ' '.join((m.group(1) if m else '').split()).lstrip('>|-').strip()
    print(f"{p.parent.name:28s} {d[:150]}")
PY
```

Read the full `SKILL.md` of anything that looks adjacent. Then decide — and the *bar
matters more than the reading*.

**The wrong bar is pairwise distinctness.** "This has a different trigger from that one" is
almost always true and almost always irrelevant; it is how you end up with forty
micro-skills. (Hermes' curator states this as a hard rule: *"Pairwise distinctness is the
wrong bar."*)

**The right bar:** *what umbrella class does this serve — and would a human maintainer
write this as N separate skills, or as ONE skill with N labeled subsections?* When the
answer is the latter, do not create; patch the umbrella and add a labeled section.

Three outcomes, in order of preference:

1. **An existing skill is already the umbrella** → propose a **patch** adding a labeled
   subsection for what you just learned. The common case, and the preferred one.
2. **Several existing skills plus this one clearly form a class, and none is broad enough
   to be the umbrella** → say so in your report and stop. Creating a new sibling makes the
   cluster worse; consolidating a cluster is a curation job, not a proposal job.
3. **No class exists — this is genuinely its own territory** → propose a new skill (Step 3a).

### App-owned skills: the patch is product feedback

Before staging a patch, check whether the target is one of the app's own lifecycle
skills:

```bash
[ -d ~/.claude/skills/.ao-base/<target-slug> ] && echo "app-owned"
```

An app-owned skill is a product primitive — the app's sync overwrites it at every
update, the way any app refreshes File > Save (a copy of local changes goes to
`.archive/`, but the live skill reverts). So a patch to one is really a statement that
**the product's default is wrong or incomplete**, and it belongs upstream, not in a
local fork that resets on every update. Still stage the patch — the local benefit is
real until the next update — but say both things plainly in your report: that it will
be overwritten by the next app sync, and that if it survives review it should be
contributed to the app's own repo (or filed as an issue there) to become permanent.

### The name is a tell

If the natural name contains a ticket number, a feature codename, a specific error string,
or reads like a session artefact (`audit-…`, `diagnosis-…`, `salvage-…`, `fix-…-2026`), it
is **not** a skill: it is a subsection or a `references/` file under a class-level skill.
Rename it to the class, or downgrade the proposal to a patch.

### Keep the trigger in the first ~60 characters

The skills index a future session sees truncates `description:`. Whatever comes after the
first ~60 characters may never be read before the load decision. Write it as
`Use when <trigger>. <one-line behaviour>.` — trigger first, capability second.

## Step 3a — Draft a NEW skill proposal

Slug: lowercase, hyphens. Write `~/.claude/skills-pending/<slug>/SKILL.md`:

```markdown
---
name: <slug>
description: >-
  <what it does + WHEN to use it — this line is all a future session sees before
  deciding to load the skill, so make the trigger conditions explicit.>
allowed-tools: <only what it needs>
origin: agent-proposed
source_session: <SESSION_ID>
proposed_at: <YYYY-MM-DD HH:MM>
version: 0.1.0
---

# <title>

<One paragraph: the problem this solves and when it applies.>

## <Steps / rules — the actual procedure>

<Concrete and ordered. Name exact commands, paths, flags. Include the FAILURE mode you
hit and why the naive approach breaks — that is the part worth keeping.>
```

Rules for the content:

- **Write the trigger, not just the capability.** `description:` is the only thing a
  future session reads before choosing to load it.
- **Keep the why.** "Do X" ages badly; "do X because Y fails when Z" survives.
- **No secrets, tokens, absolute paths under a private tree, or client names.**
- **One proposal per invocation.** If several candidates exist, stage the highest-value
  one and mention the others in your report so the user can ask for them.

## Step 3b — Draft a PATCH proposal

Write `~/.claude/skills-pending/<target-slug>.patch.md` — a document, not an applied
change. **Wrap `old_string` / `new_string` in at least FIVE backticks**, never three:
the replacement almost always contains its own ```` ``` ```` blocks, and a three-backtick
wrapper ends at the first inner closing fence — silently truncating the replacement and
writing a broken skill. `lib/patch_apply.py` refuses a three-backtick wrapper outright.

````markdown
---
target: <existing skill slug>
origin: agent-proposed
source_session: <SESSION_ID>
proposed_at: <YYYY-MM-DD HH:MM>
kind: patch
---

## Why
<What went wrong or was missing, in two lines. Reference what happened this session.>

## Change 1
`old_string:`
`````
<exact text from the target SKILL.md — must match uniquely, verbatim>
`````
`new_string:`
`````
<replacement, which may freely contain ``` fenced blocks>
`````
````

Keep patches **minimal and targeted** — one or two focused replacements. A full rewrite
is not a patch: if the skill needs rewriting, say so in `## Why` and let the user decide.

Then **verify the proposal mechanically** before you report it — do not eyeball the
anchors:

```bash
python3 ~/.claude/skills/lib/patch_apply.py check ~/.claude/skills-pending/<slug>.patch.md
```

It parses the blocks, resolves the target and requires every `old_string` to match
**exactly once**. If it prints `REFUSED`, fix the proposal — never hand a proposal to the
user that its own applier rejects.

## Step 4 — Report

Two or three lines, no ceremony:

- what was staged (new skill or patch to which skill), and its path;
- **which criterion fired** — the user needs this to judge whether it was worth it;
- `Review with /skills-review.`

Never claim the skill is active. It is not, until approved.
