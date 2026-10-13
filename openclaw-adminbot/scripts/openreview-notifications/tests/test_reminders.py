"""Acceptance reminders count even when the original decision is unavailable."""
import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path

from openreview_notifications.acceptance import classify_acceptance
from parse_notifications import main


FIXTURE = Path(__file__).parent / "fixtures" / "causcien_reminder.json"


class ReminderTests(unittest.TestCase):
    def setUp(self):
        # The original ID, date, subject, and opening paragraphs from the export.
        self.reminder = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def run_cli(self, records, *options):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "notifications.json"
            path.write_text(json.dumps(records), encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(["2025-09-24", "neurips", "--input", str(path), *options])
            return code, out.getvalue(), err.getvalue()

    def test_original_causcien_reminder_is_an_acceptance(self):
        decision = classify_acceptance(self.reminder)
        self.assertTrue(decision.accepted)
        self.assertIn("Congratulations again on having your paper accepted", decision.evidence)

    def test_common_confirmation_wording(self):
        for text in [
            "Congratulations on having your paper accepted!",
            "Congratulations once again on having your paper accepted!",
            "Once again, congratulations on having your paper accepted!",
            "Congratulations for having your paper accepted!",
            "Congratulations on getting your paper accepted!",
            "Congratulations again on your accepted paper!",
            "Congratulations on your accepted ICML 2026 paper!",
            "Congratulations once again on the acceptance of your paper!",
            "Congratulations on the acceptance of your papers!",
            "Congratulations on your paper acceptance!",
            "Congratulations once again on having your work accepted!",
        ]:
            with self.subTest(text=text):
                row = copy.deepcopy(self.reminder)
                row["content"]["text"] = text
                self.assertTrue(classify_acceptance(row).accepted)

    def test_reminder_wording_still_requires_final_paper_acceptance(self):
        for text in [
            "If successful, congratulations on having your paper accepted!",
            "Congratulations on having your paper accepted pending revision.",
            "> Congratulations on having your paper accepted!",
            "Congratulations on having your paper not accepted.",
            "Congratulations on having your workshop accepted!",
            "Congratulations on having your reviewer invitation accepted!",
            "Congratulations on your acceptance!",
            "Congratulations on having your paper accepted for review.",
            "Decision: Reject\n\nCongratulations on having your paper accepted!",
        ]:
            with self.subTest(text=text):
                row = copy.deepcopy(self.reminder)
                row["content"]["text"] = text
                self.assertFalse(classify_acceptance(row).accepted)

    def test_notification_export_includes_unidentified_acceptance(self):
        code, out, err = self.run_cli([self.reminder], "--format", "notifications")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out), [self.reminder])

    def test_unidentified_acceptance_is_reported_in_tweet_mode(self):
        code, out, err = self.run_cli([self.reminder])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn(self.reminder["id"], err)
        self.assertIn("Cannot extract paper title", err)
        self.assertNotIn("No accepted papers matched", err)

    def test_unidentified_reminder_does_not_inflate_other_paper_counts(self):
        known = copy.deepcopy(self.reminder)
        known["id"] = "known-paper"
        known["content"] = {"subject": "Decision notification for your submission 1: Example Paper",
                            "text": "Decision: Accept"}
        code, out, err = self.run_cli([self.reminder, known], "--format", "json")
        self.assertEqual(code, 0, err)
        self.assertIn(self.reminder["id"], err)
        draft = json.loads(out)[0]
        self.assertEqual(draft["paper_count"], 1)
        self.assertEqual(draft["papers"][0]["notification_ids"], ["known-paper"])


if __name__ == "__main__":
    unittest.main()
