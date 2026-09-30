import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from parse_notifications import main
from openreview_notifications.filters import filter_notifications, matches_conference, parse_min_date


class FilterTests(unittest.TestCase):
    def test_exclusive_boundary_and_original_objects(self):
        cutoff = parse_min_date("2026-09-01")
        rows = [{"cdate": cutoff + d, "domain": "EMNLP/2026/Conference", "extra": [1, 2]} for d in (-1, 0, 1)]
        result = filter_notifications(rows, cutoff, "emnlp")
        self.assertEqual(result, [rows[2]])
        self.assertIs(result[0], rows[2])

    def test_timezone(self):
        self.assertEqual(parse_min_date("2026-09-01"), parse_min_date("2026-09-01T02:00:00+02:00"))
        for invalid in ("yesterday", "2026-02-30", "2026-09-01T12:00:00"):
            with self.assertRaises(ValueError):
                parse_min_date(invalid)

    def test_venue_matching_and_false_positives(self):
        self.assertTrue(matches_conference({"domain": "NeurIPS.cc/2026/Workshop/AI4GOOD"}, "neurips"))
        self.assertFalse(matches_conference({"domain": "eacl.org/EACL/2026/Conference"}, "ACL"))
        self.assertFalse(matches_conference({"domain": "ICML.cc/2026/Conference", "content": {"subject": "EMNLP deadline"}}, "EMNLP"))
        self.assertFalse(matches_conference({"domain": "aclweb.org/ACL/ARR/2026/May"}, "EMNLP"))

    def test_fallback_and_body_not_searched(self):
        self.assertTrue(matches_conference({"content": {"fromname": "ICLR2026"}}, "ICLR"))
        self.assertTrue(matches_conference({"domain": "OpenReview.net", "content": {"subject": "EMNLP notice"}}, "EMNLP"))
        self.assertFalse(matches_conference({"content": {"text": "ICLR mention"}}, "ICLR"))

    def test_invalid_input(self):
        for value in ({}, [None], [{}], [{"cdate": True}], [{"cdate": float("nan")}], [{"cdate": "123"}]):
            with self.assertRaises(ValueError):
                filter_notifications(value, 0, "ICML")

    def test_cli_original_json_and_empty_matches(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.json"
            row = {"id": "abc", "cdate": parse_min_date("2026-09-02"), "domain": "ICML.cc/2026/Conference", "original": "preserved"}
            path.write_text(json.dumps([row]))
            for conference, expected in (("icml", [row]), ("EMNLP", [])):
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = main(["2026-09-01", conference, "--input", str(path), "--all-notifications"])
                self.assertEqual(code, 0)
                self.assertEqual(json.loads(out.getvalue()), expected)
                self.assertEqual(err.getvalue(), "")
