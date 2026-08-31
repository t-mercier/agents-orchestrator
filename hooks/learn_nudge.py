#!/usr/bin/env python3
"""UserPromptSubmit hook: nudge the model to check /learn or /skill-propose the moment a
preference, correction, or reusable procedure lands — not at session close.

Both skills already say "use PROACTIVELY" in their own description, but that framing lives
in a file the model re-reads at its own discretion. Nothing forces the check at the exact
turn a correction is typed, so it competes with whatever else the model is focused on and
regularly loses. This hook is the deterministic trigger: it reads the prompt Claude Code is
about to process, and when the user's own wording carries a durable-knowledge signal, it
injects a one-line reminder into the model's context for that turn.

Precision over recall, deliberately. A prompt like "en fait plutôt fais X" or a bare "non"
is an ordinary mid-conversation redirect, not a preference worth a note — matching on those
would fire on a large fraction of turns and train the model to ignore the nudge, which
recreates the exact problem this hook exists to fix. The phrase list below is restricted to
wording that is rare outside of an explicit "this is how it should be from now on" statement.

Throttled per session (default 15 minutes) so a burst of qualifying turns produces one nudge,
not one per message — repeats are still worth flagging eventually, since a real session can
teach more than one thing, but not on every turn.

Silent and exit 0 on every path: a broken hook must never turn a normal prompt submission
into a visible error, and a prompt with no signal must produce no output at all.
"""

import json
import os
import re
import sys
import time
import unicodedata

STATE_DIR = "~/.claude/hooks-state/learn_nudge"
THROTTLE_SECONDS = 15 * 60

# Each pattern is matched against an accent-folded, lowercased copy of the prompt.
# Kept intentionally short: every entry here is a phrase shape that shows up almost only
# when someone is stating a standing preference or correction, not routing a request.
SIGNALS = (
    (re.compile(r"\balways\b"), "always"),
    (re.compile(r"\bnever\b"), "never"),
    (re.compile(r"\btoujours\b"), "toujours"),
    (re.compile(r"\bjamais\b"), "jamais"),
    (re.compile(r"\bi prefer\b"), "i prefer"),
    (re.compile(r"\bje prefere\b"), "je préfère"),
    (re.compile(r"\bfrom now on\b"), "from now on"),
    (re.compile(r"\ba l'?avenir\b"), "à l'avenir"),
    (re.compile(r"\bnext time\b"), "next time"),
    (re.compile(r"\bla prochaine fois\b"), "la prochaine fois"),
    (re.compile(r"\bdon'?t\b.{0,25}\bany\s*more\b"), "don't ... anymore"),
    (re.compile(r"\bne\s+\w+(?:\s+\w+){0,3}\s+plus\b"), "ne ... plus"),
)

NUDGE = (
    "Signal check (learn_nudge hook): this message reads like a standing preference or "
    "correction, not just a routing choice. Silently check it against /learn's Step 1 "
    "criteria (or /skill-propose's, if what it teaches is a procedure rather than a fact) "
    "and act now if it qualifies. If it doesn't, say nothing about this check — do not "
    "report a non-finding."
)


def _fold(text):
    """Lowercase and strip accents so 'préfère' and 'prefere' match the same pattern."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def matched_signal(prompt):
    """The first signal label found in `prompt`, or None. Pure — no I/O."""
    folded = _fold(prompt or "")
    for pattern, label in SIGNALS:
        if pattern.search(folded):
            return label
    return None


def should_nudge(session_id, state_dir, now):
    """Whether enough time has passed since the last nudge for this session.

    The last-nudge time is read from the file's own content, not its mtime — mtime is the
    OS clock, `now` is the caller's, and the two only agree by accident (real production
    calls pass `time.time()`; nothing guarantees a test's fake clock does).

    A missing, unreadable, or unparsable state file means "never nudged" — nudge. Any
    error is treated the same way (fail toward nudging once, not toward silent
    suppression).
    """
    path = os.path.join(state_dir, session_id or "unknown")
    try:
        with open(path) as f:
            last = float(f.read().strip())
    except (OSError, ValueError):
        return True
    return (now - last) >= THROTTLE_SECONDS


def mark_nudged(session_id, state_dir, now):
    os.makedirs(state_dir, exist_ok=True)
    path = os.path.join(state_dir, session_id or "unknown")
    with open(path, "w") as f:
        f.write(str(now))


def run(payload, state_dir, now):
    """Pure-ish core: returns the nudge message to emit, or None. Touches the throttle
    state file as its only side effect, so the caller doesn't need to."""
    prompt = payload.get("prompt") or ""
    session_id = payload.get("session_id") or ""
    if not matched_signal(prompt):
        return None
    if not should_nudge(session_id, state_dir, now):
        return None
    mark_nudged(session_id, state_dir, now)
    return NUDGE


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        return
    try:
        message = run(payload, os.path.expanduser(STATE_DIR), time.time())
    except Exception:
        return
    if message:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": message,
            }
        }))


if __name__ == "__main__":
    main()
