#!/usr/bin/env python3
"""PostToolUse(Bash) hook: attach a freshly created PR to the session's notes.md.

The dashboard reads a session's pull requests from the `pr_link:` / `pr_links:`
frontmatter of its notes.md, and only /start-session, /save-session and /close-session
ever write those keys. A PR opened mid-session therefore stays invisible until the next
checkpoint — the session shows no PR at all, which is exactly when the link matters.

This hook closes that gap: `gh pr create` prints the URL it just opened, so the URL is
attached the moment the PR exists.

Two guards, because unlike the other hooks this one WRITES:
  1. the command must be a `gh pr create` — never `edit`, `list`, `view`, whose output
     is full of other people's PR URLs;
  2. the URL must come from the tool RESPONSE, not the command. A create that failed
     prints no URL, and a `--body` mentioning "depends on .../pull/12" must not be
     mistaken for the PR that was just opened.

Writes are idempotent (a URL already attached is a no-op), additive (an existing link is
never replaced or removed) and atomic (the app polls notes.md every 5s and must never
read a half-written file).

Silent and exit 0 on every path — a broken hook must not make a successful
`gh pr create` look like a failure.
"""

import json
import os
import re
import sys
import tempfile

# Same shape the Rust side validates (lib.rs `is_pr_url`): https only, owner/repo, number.
PR_URL = re.compile(r"https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/\d+")
CREATE_CMD = re.compile(r"\bgh\s+pr\s+create\b")

ACTIVE_SESSIONS = "~/.claude/active-sessions.json"


def pr_url_from(payload):
    """The URL of the PR this command just created, or None.

    Read from the tool response only — the command string may legitimately quote other
    PR URLs (a `--body` that references a dependency). `gh pr create` prints the new
    PR's URL last, so the last match wins when the output holds several.
    """
    if not CREATE_CMD.search((payload.get("tool_input") or {}).get("command", "") or ""):
        return None
    response = payload.get("tool_response")
    if response is None:
        return None
    found = PR_URL.findall(json.dumps(response))
    return found[-1] if found else None


def notes_path_for(session_id, registry):
    """The notes.md the given Claude session writes to, or None when it has none
    (an unmanaged session, or one the dashboard never adopted)."""
    entry = (registry or {}).get(session_id) or {}
    path = entry.get("notes_path") or ""
    return path or None


def attach(content, url):
    """Add `url` to the frontmatter, mirroring the Rust `set_frontmatter_links` shape:
    `pr_link:` carries the primary, `pr_links:` the extras. Returns the new content, or
    None when nothing needs to change.

    Never replaces an existing primary and never removes a link — the frontmatter is the
    user's, and a hook that silently rewrote it would be worse than one that misses.
    """
    lines = content.split("\n")
    if not lines or lines[0].strip() != "---":
        return None                                   # no frontmatter → not ours to create
    try:
        end = lines.index("---", 1)
    except ValueError:
        return None                                   # unterminated → leave it alone

    if url in "\n".join(lines[:end]):
        return None                                   # already attached

    primary = None
    for i in range(1, end):
        if lines[i].startswith("pr_link:"):
            primary = i
            break
    if primary is None:
        return None                                   # not a session notes.md

    if lines[primary][len("pr_link:"):].strip():
        # A primary is already set — append under `pr_links:`, creating the block when
        # this is the second PR.
        extras = next((i for i in range(1, end) if lines[i].startswith("pr_links:")), None)
        if extras is None:
            lines.insert(primary + 1, "pr_links:")
            lines.insert(primary + 2, "  - " + url)
        else:
            last = extras
            for i in range(extras + 1, end):
                if lines[i].startswith("  - "):
                    last = i
                else:
                    break
            lines.insert(last + 1, "  - " + url)
    else:
        lines[primary] = "pr_link: " + url
    return "\n".join(lines)


def write_atomic(path, content):
    """Replace `path` in one rename — the dashboard polls it and must never see a
    truncated file."""
    folder = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".pr_attach-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def run(payload, registry):
    """Pure core: returns the systemMessage to print, or None. Does the write as a side
    effect so the whole decision path stays testable with a fake registry."""
    url = pr_url_from(payload)
    if not url:
        return None
    path = notes_path_for(payload.get("session_id") or "", registry)
    if not path or not os.path.isfile(path):
        return None
    with open(path) as f:
        content = f.read()
    updated = attach(content, url)
    if updated is None:
        return None
    write_atomic(path, updated)
    return "Attached {} to this session's notes.".format(url)


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        return
    try:
        with open(os.path.expanduser(ACTIVE_SESSIONS)) as f:
            registry = json.load(f)
    except Exception:
        return
    try:
        message = run(payload, registry)
    except Exception:
        return
    if message:
        print(json.dumps({"systemMessage": message}))


if __name__ == "__main__":
    main()
