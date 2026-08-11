#!/usr/bin/env python3
"""Tests for the pr_attach hook. Run: python3 hooks/test_pr_attach.py"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pr_attach  # noqa: E402

CREATE = "gh pr create --title x --body y"
URL = "https://github.com/o/r/pull/7"
OTHER = "https://github.com/o/r/pull/99"

FM = "---\nsession_id: s1\ncategory: C\nticket:\nname: n\npr_link:\n---\n\n# n\n"


def payload(cmd, stdout, session_id="s1"):
    return {"session_id": session_id,
            "tool_input": {"command": cmd},
            "tool_response": {"stdout": stdout, "stderr": "", "interrupted": False}}


class TestUrlExtraction(unittest.TestCase):
    def test_create_prints_url(self):
        self.assertEqual(pr_attach.pr_url_from(payload(CREATE, URL)), URL)

    def test_failed_create_prints_no_url(self):
        self.assertIsNone(pr_attach.pr_url_from(payload(CREATE, "pull request create failed")))

    def test_ignores_non_create_commands(self):
        for cmd in ("gh pr list", "gh pr view 7", "gh pr edit 7 --body x"):
            self.assertIsNone(pr_attach.pr_url_from(payload(cmd, URL)), cmd)

    def test_url_in_the_command_is_not_enough(self):
        # A --body referencing a dependency PR must not be attached.
        cmd = 'gh pr create --body "depends on {}"'.format(OTHER)
        self.assertIsNone(pr_attach.pr_url_from(payload(cmd, "")))

    def test_last_url_wins(self):
        out = "see {}\ncreated {}".format(OTHER, URL)
        self.assertEqual(pr_attach.pr_url_from(payload(CREATE, out)), URL)

    def test_rejects_malformed_urls(self):
        for bad in ("http://github.com/o/r/pull/7", "https://github.com/o/r/pull/abc",
                    "https://gitlab.com/o/r/pull/7"):
            self.assertIsNone(pr_attach.pr_url_from(payload(CREATE, bad)), bad)


class TestAttach(unittest.TestCase):
    def test_fills_the_empty_primary(self):
        out = pr_attach.attach(FM, URL)
        self.assertIn("pr_link: " + URL, out)
        self.assertNotIn("pr_links:", out)

    def test_second_pr_opens_the_extras_block(self):
        first = pr_attach.attach(FM, URL)
        out = pr_attach.attach(first, OTHER)
        self.assertIn("pr_link: " + URL, out)          # primary untouched
        self.assertIn("pr_links:\n  - " + OTHER, out)

    def test_third_pr_appends_to_the_extras(self):
        out = pr_attach.attach(pr_attach.attach(pr_attach.attach(FM, URL), OTHER),
                               "https://github.com/o/r/pull/3")
        self.assertIn("  - " + OTHER + "\n  - https://github.com/o/r/pull/3", out)

    def test_already_attached_is_a_no_op(self):
        self.assertIsNone(pr_attach.attach(pr_attach.attach(FM, URL), URL))

    def test_body_mentions_do_not_count_as_attached(self):
        body = FM + "\nSee " + URL + " for context.\n"
        self.assertIn("pr_link: " + URL, pr_attach.attach(body, URL))

    def test_ignores_files_without_frontmatter(self):
        self.assertIsNone(pr_attach.attach("# just a heading\n", URL))

    def test_ignores_frontmatter_without_a_pr_link_key(self):
        self.assertIsNone(pr_attach.attach("---\nname: n\n---\n", URL))

    def test_ignores_unterminated_frontmatter(self):
        self.assertIsNone(pr_attach.attach("---\npr_link:\n", URL))


class TestRun(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.notes = os.path.join(self.dir, "notes.md")
        with open(self.notes, "w") as f:
            f.write(FM)
        self.registry = {"s1": {"notes_path": self.notes}}

    def read(self):
        with open(self.notes) as f:
            return f.read()

    def test_writes_the_link(self):
        self.assertIsNotNone(pr_attach.run(payload(CREATE, URL), self.registry))
        self.assertIn("pr_link: " + URL, self.read())

    def test_unknown_session_writes_nothing(self):
        self.assertIsNone(pr_attach.run(payload(CREATE, URL, "unknown"), self.registry))
        self.assertEqual(self.read(), FM)

    def test_session_without_notes_writes_nothing(self):
        self.assertIsNone(pr_attach.run(payload(CREATE, URL), {"s1": {}}))
        self.assertEqual(self.read(), FM)

    def test_missing_notes_file_writes_nothing(self):
        reg = {"s1": {"notes_path": os.path.join(self.dir, "gone.md")}}
        self.assertIsNone(pr_attach.run(payload(CREATE, URL), reg))

    def test_running_twice_writes_once(self):
        pr_attach.run(payload(CREATE, URL), self.registry)
        self.assertIsNone(pr_attach.run(payload(CREATE, URL), self.registry))
        self.assertEqual(self.read().count(URL), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
