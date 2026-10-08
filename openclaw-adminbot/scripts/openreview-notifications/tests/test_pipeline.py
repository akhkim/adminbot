import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from parse_notifications import main


class PipelineTests(unittest.TestCase):
    def run_cli(self, records, *options):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "notifications.json"
            source.write_text(json.dumps(records))
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(["2026-09-01", "neurips", "--input", str(source), *options])
            return code, out.getvalue(), err.getvalue()

    def records(self):
        def row(ident, title, decision="Accept", domain="NeurIPS.cc/2026/Conference", date=1790000000000):
            return {"id": ident, "cdate": date, "domain": domain, "content": {
                "subject": f"Decision notification for your submission 1: {title}",
                "text": f"Decision: {decision}"}}
        return [row("a", "Learning to Reason"), row("a2", "Learning to Reason"),
                row("b", "Rejected Work", decision="Reject"),
                row("c", "Other Conference", domain="ICML.cc/2026/Conference"),
                row("d", "Old Work", date=1)]

    def test_default_is_tweets_after_full_pipeline(self):
        code, out, err = self.run_cli(self.records(), "--template", "1")
        self.assertEqual(code, 0, err)
        self.assertEqual(out, (
            "🎉 Big congrats to our team on these acceptances at #NeurIPS2026!\n\n"
            "1. Learning to Reason (Main conference)\n\n"
            "Thanks to all our collaborators!\n\n"
            '@MPI_IS @ELLISforEurope @UofTCompSci @VectorInst @TorontoSRI @CIFAR_News @JinesisLab @EuroSafeAI @ELLISInst_Tue\n'
        ))
        self.assertEqual(out.count("Learning to Reason"), 1)
        for excluded in ["Rejected Work", "Other Conference", "Old Work", '"cdate"']:
            self.assertNotIn(excluded, out)

    def test_structured_tweet_output_and_template_selection(self):
        code, out, err = self.run_cli(self.records(), "--format", "json", "--template", "5")
        self.assertEqual(code, 0, err)
        draft = json.loads(out)[0]
        self.assertEqual(draft["template"], 5)
        self.assertEqual(draft["paper_count"], 1)
        self.assertTrue(draft["text"])
        self.assertEqual(draft["papers"][0]["notification_ids"], ["a", "a2"])

    def test_empty_text_and_json(self):
        code, out, err = self.run_cli([])
        self.assertEqual(code, 0)
        self.assertEqual(out, "")
        self.assertIn("No accepted papers", err)
        code, out, err = self.run_cli([], "--format", "json")
        self.assertEqual(json.loads(out), [])

    def test_invalid_json_export_does_not_write_partial_output(self):
        records = self.records()[:1]
        records[0]["invalid_extra"] = float("nan")
        code, out, err = self.run_cli(records, "--format", "notifications")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")

    def test_plain_text_combines_tracks_without_separators(self):
        records = self.records()[:1]
        records.append({**records[0], "domain": "NeurIPS.cc/2026/Workshop/Test"})
        code, out, err = self.run_cli(records, "--template", "1")
        self.assertEqual(code, 0, err)
        self.assertNotIn("===", out)
        self.assertNotIn("---", out)
        self.assertEqual(out.count("Big congrats to our team"), 1)
        self.assertIn("1. Learning to Reason (Main conference)", out)
        self.assertIn("2. Learning to Reason (Test workshop)", out)
        self.assertIn("Main conference", out)
        self.assertIn("Test workshop", out)

    def test_generic_reminder_does_not_block_identifiable_papers(self):
        records = self.records()[:1]
        records.append({**records[0], "content": {"subject": "Decision", "text": "Decision: Accept"}})
        code, out, err = self.run_cli(records)
        self.assertEqual(code, 0)
        self.assertIn("Learning to Reason", out)
        self.assertIn("Skipped:", err)
        self.assertIn("Cannot extract paper title", err)
        code, out, err = self.run_cli(records[1:])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")


if __name__ == "__main__":
    unittest.main()
