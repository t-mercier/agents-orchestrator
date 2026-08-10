#!/usr/bin/env python3
"""Parse, verify, diff and apply a staged skill patch proposal.

Why this exists: a patch's `new_string` routinely contains fenced code blocks of its own
(a bash example, a JQL snippet). With a plain ``` fence around it, where the block ends is
ambiguous — a parser can silently take the wrong slice and write mangled instructions into
a skill, which then shapes every future session. So the format uses an OUTER fence longer
than anything inside it (CommonMark: a fence closes only on a run of at least its own
length), and this tool is the single implementation of that rule.

It refuses rather than guesses: an anchor that does not match exactly once, an unclosed
fence, or an outer fence no longer than an inner one all abort with a non-zero exit.

    python3 patch_apply.py check <proposal.patch.md>   # parse + anchor check only
    python3 patch_apply.py diff  <proposal.patch.md>   # unified diff of what apply would do
    python3 patch_apply.py apply <proposal.patch.md>   # write it (after check)
    python3 patch_apply.py selftest

Target resolution: `target:` in the proposal frontmatter → ~/.claude/skills/<target>/SKILL.md
(override the root with CLAUDE_HOME).
"""

import difflib
import os
import re
import sys

FENCE_RE = re.compile(r"^(`{3,})\s*$")
MARKER_RE = re.compile(r"^`(old_string|new_string):`\s*$")


class PatchError(Exception):
    pass


def claude_home():
    return os.path.expanduser(os.environ.get("CLAUDE_HOME", "~/.claude"))


def _read_fenced(lines, i):
    """Read one fenced block starting at line i (which must BE the opening fence).

    Returns (content, index_after_closing_fence). The closing fence must be a run of at
    least as many backticks as the opening one — that is what lets a 5-backtick wrapper
    safely contain 3-backtick examples.
    """
    m = FENCE_RE.match(lines[i])
    if not m:
        raise PatchError(f"line {i + 1}: expected a ``` fence, got {lines[i]!r}")
    open_len = len(m.group(1))
    # A 3-backtick wrapper is REFUSED, not parsed: content routinely holds its own
    # ```bash blocks, and the first inner closing fence would end the capture early —
    # silently truncating the replacement and writing a broken skill. Demanding 4+
    # turns that whole failure class into a loud error.
    if open_len < 4:
        raise PatchError(
            f"line {i + 1}: old_string/new_string must be wrapped in at least 4 backticks "
            f"(got {open_len}). Use a fence longer than any fence inside the content."
        )
    body = []
    j = i + 1
    while j < len(lines):
        inner = FENCE_RE.match(lines[j])
        if inner and len(inner.group(1)) >= open_len:
            return "\n".join(body), j + 1
        body.append(lines[j])
        j += 1
    raise PatchError(f"line {i + 1}: fence opened with {open_len} backticks is never closed")


def parse(text):
    """→ (frontmatter dict, [(old, new), ...]). Raises PatchError on anything ambiguous."""
    fm = {}
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                if ":" in line and not line.startswith((" ", "-")):
                    k, v = line.split(":", 1)
                    fm[k.strip()] = v.strip()

    lines = text.split("\n")
    changes, pending = [], {}
    i = 0
    while i < len(lines):
        m = MARKER_RE.match(lines[i])
        if not m:
            i += 1
            continue
        kind = m.group(1)
        # Skip blank lines between the marker and its fence.
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j >= len(lines):
            raise PatchError(f"line {i + 1}: `{kind}:` has no block after it")
        content, i = _read_fenced(lines, j)
        if kind == "old_string":
            if "old" in pending:
                raise PatchError("two `old_string:` blocks with no `new_string:` between them")
            pending["old"] = content
        else:
            if "old" not in pending:
                raise PatchError("`new_string:` with no preceding `old_string:`")
            changes.append((pending.pop("old"), content))
    if pending:
        raise PatchError("trailing `old_string:` with no `new_string:`")
    if not changes:
        raise PatchError("no old_string/new_string pair found")
    return fm, changes


def target_path(fm):
    target = fm.get("target")
    if not target:
        raise PatchError("frontmatter has no `target:`")
    if "/" in target or target.startswith("."):
        raise PatchError(f"unsafe target {target!r}")
    return os.path.join(claude_home(), "skills", target, "SKILL.md")


def apply_changes(body, changes):
    """Apply in order, requiring each anchor to match EXACTLY once at the time it is
    applied — an earlier change can create or destroy a later one's anchor, so the count
    is re-checked as we go rather than all up front."""
    for n, (old, new) in enumerate(changes, 1):
        if not old:
            raise PatchError(f"change {n}: empty old_string")
        # Idempotency guard. "Exactly one match" is NOT enough when the replacement
        # re-includes the anchor — the "insert before X" shape, where new_string ends
        # with X. After a first apply the anchor still matches once, so a second run
        # would silently insert the block twice. That double application is possible
        # exactly when `old in new`, so guard precisely that case.
        if old in new and new in body:
            raise PatchError(
                f"change {n}: already applied — the replacement is already present in the "
                f"target. Delete the stale proposal instead of re-applying it."
            )
        count = body.count(old)
        if count != 1:
            raise PatchError(
                f"change {n}: old_string matches {count}x in the target, need exactly 1 "
                f"(first line: {old.splitlines()[0][:70]!r})"
            )
        body = body.replace(old, new, 1)
    return body


def load(path):
    with open(path) as fh:
        text = fh.read()
    fm, changes = parse(text)
    tp = target_path(fm)
    if not os.path.isfile(tp):
        raise PatchError(f"target skill not found: {tp}")
    with open(tp) as fh:
        body = fh.read()
    return fm, changes, tp, body


def cmd_check(path):
    fm, changes, tp, body = load(path)
    apply_changes(body, changes)   # raises if any anchor is wrong
    print(f"ok: {len(changes)} change(s), all anchors match exactly once")
    print(f"target: {tp}")
    return 0


def cmd_diff(path):
    fm, changes, tp, body = load(path)
    new_body = apply_changes(body, changes)
    diff = difflib.unified_diff(
        body.splitlines(keepends=True), new_body.splitlines(keepends=True),
        fromfile=f"current  {os.path.basename(tp)}", tofile="proposed", n=3,
    )
    sys.stdout.writelines(diff)
    return 0


def cmd_apply(path):
    fm, changes, tp, body = load(path)
    new_body = apply_changes(body, changes)
    if new_body == body:
        raise PatchError("applying would change nothing")
    tmp = tp + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(new_body)
    os.replace(tmp, tp)
    print(f"applied {len(changes)} change(s) → {tp}")
    return 0


def selftest():
    # The case that motivated this tool: new_string contains its own ``` blocks.
    proposal = (
        "---\ntarget: demo\nkind: patch\n---\n\n"
        "## Why\nFixture.\n\n"
        "## Change 1\n"
        "`old_string:`\n`````\n## Step 4\n`````\n"
        "`new_string:`\n`````\n## Step 3b\n\nRun:\n\n```bash\necho hi\n```\n\n---\n\n## Step 4\n`````\n"
    )
    fm, changes = parse(proposal)
    checks = [("frontmatter target", fm.get("target"), "demo"),
              ("one change parsed", len(changes), 1),
              ("old_string exact", changes[0][0], "## Step 4"),
              ("nested fence survived", "```bash\necho hi\n```" in changes[0][1], True),
              ("new_string not truncated", changes[0][1].strip().endswith("## Step 4"), True)]

    body = "intro\n\n## Step 4\n\ntail\n"
    out = apply_changes(body, changes)
    checks.append(("applied once", out.count("## Step 4"), 1))
    checks.append(("nested block landed", "echo hi" in out, True))

    def raises(text, body_="x"):
        try:
            fm2, ch = parse(text)
            apply_changes(body_, ch)
            return False
        except PatchError:
            return True

    unclosed = "---\ntarget: d\n---\n## Change 1\n`old_string:`\n`````\nabc\n"
    checks.append(("unclosed fence refused", raises(unclosed), True))
    # The old 3-backtick format silently truncated a new_string containing ```bash.
    three = ("---\ntarget: d\n---\n## Change 1\n`old_string:`\n```\nab\n```\n"
             "`new_string:`\n```\ncd\n```\n")
    checks.append(("3-backtick wrapper refused", raises(three, "ab"), True))
    ambiguous = ("---\ntarget: d\n---\n## Change 1\n`old_string:`\n```\nab\n```\n"
                 "`new_string:`\n```\ncd\n```\n")
    checks.append(("anchor absent refused", raises(ambiguous, "zzz"), True))
    twice = ("---\ntarget: d\n---\n## Change 1\n`old_string:`\n```\nab\n```\n"
             "`new_string:`\n```\ncd\n```\n")
    checks.append(("anchor twice refused", raises(twice, "ab ab"), True))
    orphan = "---\ntarget: d\n---\n## Change 1\n`new_string:`\n```\ncd\n```\n"
    checks.append(("orphan new_string refused", raises(orphan), True))

    # Re-applying an "insert before X" patch must be refused, not doubled.
    ins = ("---\ntarget: d\n---\n## Change 1\n`old_string:`\n`````\nX\n`````\n"
           "`new_string:`\n`````\nNEW\n\nX\n`````\n")
    _fm, ins_ch = parse(ins)
    once = apply_changes("before\nX\nafter\n", ins_ch)
    checks.append(("insert-before applies once", once.count("NEW"), 1))
    checks.append(("re-apply refused (idempotent)", raises(ins, once), True))

    failed = 0
    for label, got, want in checks:
        ok = got == want
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  (got {got!r})"))
    print(f"{len(checks) - failed}/{len(checks)} passed")
    return 1 if failed else 0


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__.strip().split("\n\n")[-2], file=sys.stderr)
        sys.exit(2)
    cmd = args[0]
    if cmd == "selftest":
        sys.exit(selftest())
    if len(args) < 2:
        print(f"usage: patch_apply.py {cmd} <proposal.patch.md>", file=sys.stderr)
        sys.exit(2)
    fn = {"check": cmd_check, "diff": cmd_diff, "apply": cmd_apply}.get(cmd)
    if not fn:
        print("usage: patch_apply.py check|diff|apply <proposal.patch.md> | selftest",
              file=sys.stderr)
        sys.exit(2)
    try:
        sys.exit(fn(args[1]))
    except PatchError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        sys.exit(1)


main()
