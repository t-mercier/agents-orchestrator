#!/usr/bin/env python3
"""Tests for the learn_nudge hook. Run: python3 hooks/test_learn_nudge.py"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import learn_nudge  # noqa: E402


class TestMatchedSignal(unittest.TestCase):
    def test_matches_each_signal_phrase(self):
        cases = [
            "please always run tests before committing",
            "never mock the database in integration tests",
            "fais toujours ça avant de commit",
            "ne fais jamais ça sans demander",
            "I prefer contribute to over drive",
            "je prefere contribute to plutot que drive",
            "from now on skip the changelog bump",
            "a l'avenir mets le ticket en premier",
            "next time ask before force-pushing",
            "la prochaine fois demande avant de push",
            "don't add comments like that anymore",
            "je ne veux plus de commentaires comme ça",
        ]
        for prompt in cases:
            self.assertIsNotNone(learn_nudge.matched_signal(prompt), prompt)

    def test_accent_insensitive(self):
        self.assertIsNotNone(learn_nudge.matched_signal("je préfère cette version"))
        self.assertIsNotNone(learn_nudge.matched_signal("à l'avenir fais ça avant"))

    def test_ignores_weak_redirects(self):
        # Explicitly excluded per design: these fire on a large fraction of ordinary
        # mid-conversation redirects and would train the model to ignore the nudge.
        for prompt in (
            "en fait plutôt fais X",
            "non, fais plutôt Y",
            "plutot celle-la",
            "en fait laisse tomber",
        ):
            self.assertIsNone(learn_nudge.matched_signal(prompt), prompt)

    def test_ignores_plain_requests(self):
        for prompt in (
            "can you fix the failing test",
            "what does this function do",
            "run the build please",
            "peux-tu regarder ce fichier",
        ):
            self.assertIsNone(learn_nudge.matched_signal(prompt), prompt)

    def test_empty_or_missing_prompt(self):
        self.assertIsNone(learn_nudge.matched_signal(""))
        self.assertIsNone(learn_nudge.matched_signal(None))


class TestThrottle(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_first_call_nudges(self):
        self.assertTrue(learn_nudge.should_nudge("s1", self.dir, 1000.0))

    def test_second_call_within_window_is_suppressed(self):
        learn_nudge.mark_nudged("s1", self.dir, 1000.0)
        self.assertFalse(learn_nudge.should_nudge("s1", self.dir, 1000.0 + 60))

    def test_call_after_window_nudges_again(self):
        learn_nudge.mark_nudged("s1", self.dir, 1000.0)
        self.assertTrue(
            learn_nudge.should_nudge("s1", self.dir, 1000.0 + learn_nudge.THROTTLE_SECONDS + 1)
        )

    def test_sessions_are_independent(self):
        learn_nudge.mark_nudged("s1", self.dir, 1000.0)
        self.assertTrue(learn_nudge.should_nudge("s2", self.dir, 1000.0 + 60))


class TestRun(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_signal_emits_the_nudge(self):
        payload = {"prompt": "always run the linter first", "session_id": "s1"}
        self.assertEqual(learn_nudge.run(payload, self.dir, 1000.0), learn_nudge.NUDGE)

    def test_no_signal_emits_nothing(self):
        payload = {"prompt": "fix the failing test please", "session_id": "s1"}
        self.assertIsNone(learn_nudge.run(payload, self.dir, 1000.0))

    def test_repeated_signal_within_window_emits_once(self):
        payload = {"prompt": "never do that again", "session_id": "s1"}
        self.assertIsNotNone(learn_nudge.run(payload, self.dir, 1000.0))
        self.assertIsNone(learn_nudge.run(payload, self.dir, 1000.0 + 5))

    def test_missing_session_id_does_not_crash(self):
        payload = {"prompt": "always do this"}
        self.assertIsNotNone(learn_nudge.run(payload, self.dir, 1000.0))

    def test_missing_prompt_does_not_crash(self):
        self.assertIsNone(learn_nudge.run({"session_id": "s1"}, self.dir, 1000.0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
