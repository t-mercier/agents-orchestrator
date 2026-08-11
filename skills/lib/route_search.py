#!/usr/bin/env python3
"""Search the knowledge notes and past session notes for a Context Brief.

Why a script and not inline python in the skill: the previous inline version passed its
query and its vault path through environment variables that nothing ever exported, so the
term list was always empty and every search silently scored zero — the skill reported "no
match" for its entire life. Arguments cannot be forgotten the way an export can.

    route_search.py notes    <query> <vault> [<vault>...]
    route_search.py areas    <query> <vault> [<vault>...]
    route_search.py mocs     <query> <vault> [<vault>...]
    route_search.py sessions <query> [<root>...]     # roots default to the configured ones
    route_search.py selftest

Layout is discovered, not assumed. A vault organised as `20-Notes/` · `10-Areas/` ·
`30-MOCs/` is used as such; anything else is scanned as a flat folder of Markdown, so the
skill works for someone who just pointed a space at a notes directory.
"""

import os
import re
import sys

SKIP_DIRS = {".git", ".obsidian", ".archive", ".trash", "node_modules", ".stversions"}
NOTES_DIRS = ("20-Notes", "notes")
AREAS_DIRS = ("10-Areas", "areas")
MOCS_DIRS = ("30-MOCs", "mocs", "MOCs")
HEAD_CHARS = 800          # frontmatter + opening prose is where the identifying terms live
MAX_RESULTS = 5


def terms_of(query):
    """Lowercased words worth matching. Punctuation is stripped so `GOSDK-210557` also
    matches on its bare number, and one-character noise is dropped."""
    raw = re.split(r"[\s,;/]+", (query or "").lower())
    out = []
    for t in raw:
        t = t.strip("()[]{}\"'`.:")
        if len(t) > 1 and t not in out:
            out.append(t)
    return out


def md_files(base, subdirs=()):
    """Markdown files under `base`, preferring a known subdirectory when present."""
    if not os.path.isdir(base):
        return []
    for sub in subdirs:
        cand = os.path.join(base, sub)
        if os.path.isdir(cand):
            base = cand
            break
    hits = []
    for dirpath, dirs, names in os.walk(base):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for n in names:
            if n.endswith(".md"):
                hits.append(os.path.join(dirpath, n))
    return sorted(hits)


def read_head(path):
    try:
        with open(path, errors="ignore") as fh:
            return fh.read(HEAD_CHARS * 2)
    except OSError:
        return ""


def title_of(text, fallback):
    m = re.search(r"^#\s+(.+)$", text, re.M)
    if m:
        return m.group(1).strip()
    m = re.search(r"^(?:title|name):\s*(.+)$", text, re.M)
    return m.group(1).strip() if m else fallback


def score(text, terms):
    """How many distinct query terms appear. Not a relevance model — just enough to rank,
    and to distinguish "something is here" from "nothing is here"."""
    hay = text[:HEAD_CHARS].lower()
    return sum(1 for t in terms if t in hay)


def search_files(paths, terms):
    out = []
    for p in paths:
        text = read_head(p)
        s = score(text, terms)
        if s > 0:
            out.append((s, os.path.splitext(os.path.basename(p))[0],
                        title_of(text, os.path.basename(p)), p))
    out.sort(key=lambda r: (-r[0], r[1]))
    return out


def configured_roots():
    """Session roots from the shared config.

    Shelled out, NOT imported: aoconfig.py calls main() at module level, so importing it
    executes its CLI against *our* argv — which printed "bad usage" and exited. Every other
    skill shells out to it too, so this also keeps one way of asking.
    """
    import subprocess
    lib = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aoconfig.py")
    def ask(*args):
        try:
            out = subprocess.run([sys.executable, lib, *args], capture_output=True, text=True)
            return [l for l in out.stdout.splitlines() if l.strip()]
        except Exception:
            return []
    return [p for name in ask("roots") for p in ask("rootpath", name)]


def cmd_notes(query, vaults, subdirs=NOTES_DIRS, label="note"):
    terms = terms_of(query)
    if not terms:
        print("(empty query)")
        return 0
    found = False
    for v in vaults:
        rows = search_files(md_files(v, subdirs), terms)
        for s, ident, title, _p in rows[:MAX_RESULTS]:
            found = True
            print(f"- [[{ident}]] — {title}   (score {s})")
    if not found:
        print(f"(no {label} matched {terms})")
    return 0


def cmd_sessions(query, roots):
    terms = terms_of(query)
    if not terms:
        print("(empty query)")
        return 0
    roots = roots or configured_roots()
    rows = []
    for r in roots:
        if not os.path.isdir(r):
            continue
        for dirpath, dirs, names in os.walk(r):
            # Session notes live at <root>/<CATEGORY>/<slug>/notes.md — going deeper just
            # walks into checked-out repos, which is slow and never a session.
            if dirpath[len(r):].count(os.sep) > 2:
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            if "notes.md" not in names:
                continue
            p = os.path.join(dirpath, "notes.md")
            text = read_head(p)
            s = score(text, terms)
            if s <= 0:
                continue
            # `[ \t]*`, not `\s*`: \s matches a newline, so an empty `ticket:` field made the
            # capture swallow the following line and report `name: …` as the ticket.
            fm = lambda k: (re.search(rf"^{k}:[ \t]*(.*)$", text, re.M) or [None, ""])[1].strip()
            dates = re.findall(r"^- (\d{4}-\d{2}-\d{2})", text, re.M)
            parts = p.split(os.sep)
            rows.append((s, parts[-3] if len(parts) >= 3 else "?", parts[-2],
                         fm("ticket"), dates[-1] if dates else "?", fm("name")))
    rows.sort(key=lambda r: -r[0])
    if not rows:
        print(f"(no session matched {terms})")
    for s, cat, slug, ticket, last, name in rows[:MAX_RESULTS]:
        tk = f" [{ticket}]" if ticket else ""
        print(f"- {cat}/{slug}{tk} (last: {last}) — {name}   (score {s})")
    return 0


def selftest():
    import shutil
    import tempfile
    tmp = tempfile.mkdtemp()
    checks = []
    try:
        # A PARA-ish vault.
        notes = os.path.join(tmp, "vault", "20-Notes")
        areas = os.path.join(tmp, "vault", "10-Areas")
        os.makedirs(notes), os.makedirs(areas)
        open(os.path.join(notes, "20260101-0000-camera-reset.md"), "w").write(
            "---\ntags: [camera, reset]\n---\n# Camera reset loses the pose\nbody\n")
        open(os.path.join(notes, "20260102-0000-unrelated.md"), "w").write(
            "---\ntags: [billing]\n---\n# Invoice rounding\nbody\n")
        open(os.path.join(areas, "area-rendering.md"), "w").write(
            "# Area — Rendering\nCamera, tiles.\n")
        mocs = os.path.join(tmp, "vault", "30-MOCs")
        os.makedirs(mocs)
        open(os.path.join(mocs, "moc-rendering.md"), "w").write(
            "---\ntype: moc\n---\n# Map of Content — camera\n")
        # Skipped dirs must not be scanned.
        os.makedirs(os.path.join(tmp, "vault", ".obsidian"))
        open(os.path.join(tmp, "vault", ".obsidian", "camera.md"), "w").write("camera reset")

        moc_files = md_files(os.path.join(tmp, "vault"), MOCS_DIRS)
        checks.append(("prefers 30-MOCs/", all("30-MOCs" in f for f in moc_files), True))
        checks.append(("the MOC is found", len(search_files(moc_files, terms_of("camera"))), 1))
        files = md_files(os.path.join(tmp, "vault"), NOTES_DIRS)
        checks.append(("prefers 20-Notes/", all("20-Notes" in f for f in files), True))
        checks.append(("2 notes found", len(files), 2))
        rows = search_files(files, terms_of("camera reset"))
        checks.append(("matches the right note", rows[0][1], "20260101-0000-camera-reset"))
        checks.append(("only the matching note", len(rows), 1))
        checks.append((".obsidian skipped",
                       any(".obsidian" in f for f in md_files(os.path.join(tmp, "vault"))), False))

        # A flat folder (no 20-Notes) must still work.
        flat = os.path.join(tmp, "flat")
        os.makedirs(flat)
        open(os.path.join(flat, "a.md"), "w").write("# Camera reset\n")
        checks.append(("flat layout scanned", len(md_files(flat, NOTES_DIRS)), 1))

        # Query parsing: the bug class that killed the old version was an empty term list.
        checks.append(("ticket key kept", "gosdk-210557" in terms_of("GOSDK-210557"), True))
        checks.append(("noise dropped", terms_of("a of x"), ["of"]))
        checks.append(("empty query → no terms", terms_of(""), []))
        checks.append(("punctuation stripped", terms_of('"camera",'), ["camera"]))

        # Session walk: depth-limited, so a repo checkout under a session is not crawled.
        sess = os.path.join(tmp, "root", "FEAT", "my-slug")
        os.makedirs(sess)
        open(os.path.join(sess, "notes.md"), "w").write(
            "---\nticket: ABC-1\nname: camera work\n---\n## Session history\n- 2026-01-05 | x\n")
        deep = os.path.join(sess, "repo", "sub", "deep")
        os.makedirs(deep)
        open(os.path.join(deep, "notes.md"), "w").write("camera\n")
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cmd_sessions("camera", [os.path.join(tmp, "root")])
        out = buf.getvalue()
        checks.append(("session matched", "FEAT/my-slug [ABC-1]" in out, True))
        checks.append(("deep repo not crawled", out.count("- ") == 1, True))

        # An EMPTY frontmatter field must not swallow the next line.
        sess2 = os.path.join(tmp, "root2", "BUG", "no-ticket")
        os.makedirs(sess2)
        open(os.path.join(sess2, "notes.md"), "w").write(
            "---\nticket:\nname: camera thing\n---\nbody\n")
        buf2 = io.StringIO()
        with contextlib.redirect_stdout(buf2):
            cmd_sessions("camera", [os.path.join(tmp, "root2")])
        out2 = buf2.getvalue()
        checks.append(("empty ticket stays empty", "[name:" not in out2, True))
        checks.append(("name still read", "camera thing" in out2, True))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    failed = 0
    for label, got, want in checks:
        ok = got == want
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f"  (got {got!r}, want {want!r})"))
    print(f"{len(checks) - failed}/{len(checks)} passed")
    return 1 if failed else 0


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__.strip().split("\n\n")[2], file=sys.stderr)
        sys.exit(2)
    cmd = args[0]
    if cmd == "selftest":
        sys.exit(selftest())
    if len(args) < 2:
        print(f"usage: route_search.py {cmd} <query> ...", file=sys.stderr)
        sys.exit(2)
    query, rest = args[1], args[2:]
    if cmd == "notes":
        sys.exit(cmd_notes(query, rest))
    if cmd == "areas":
        sys.exit(cmd_notes(query, rest, AREAS_DIRS, "area"))
    if cmd == "mocs":
        sys.exit(cmd_notes(query, rest, MOCS_DIRS, "MOC"))
    if cmd == "sessions":
        sys.exit(cmd_sessions(query, rest))
    print("usage: route_search.py notes|areas|mocs|sessions <query> ... | selftest",
          file=sys.stderr)
    sys.exit(2)


main()
