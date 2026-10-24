import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from parse_notifications import main
from openreview_notifications.filters import matches_conference, validate_selected_venues


class FinalVenueTests(unittest.TestCase):
    def test_same_conference_allows_different_years_and_tracks(self):
        records = [{"domain": domain} for domain in [
            "NeurIPS.cc/2025/Conference", "NeurIPS.cc/2026/Workshop/CauScien",
            "NeurIPS.cc/2026/Position_Paper_Track",
        ]]
        validate_selected_venues(records, "neurips")
        validate_selected_venues([], "neurips")

    def test_mixed_conferences_fail_with_record_id(self):
        records = [{"id": "right", "domain": "ICML.cc/2026/Conference"},
                   {"id": "wrong", "domain": "ICLR.cc/2026/Conference"}]
        with self.assertRaisesRegex(ValueError, r"wrong.*expected ICML.*ICLR"):
            validate_selected_venues(records, "ICML")

    def test_conflicting_lower_priority_metadata_is_caught(self):
        record = {"id": "conflict", "domain": "ICML.cc/2026/Conference",
                  "invitation": "ICLR.cc/2026/Conference/-/Decision"}
        self.assertTrue(matches_conference(record, "ICML"))
        with self.assertRaisesRegex(ValueError, "invitation=ICLR"):
            validate_selected_venues([record], "ICML")

    def test_sender_only_match_is_unverified(self):
        record = {"id": "unverified", "content": {"fromName": "ICML2026"}}
        self.assertTrue(matches_conference(record, "ICML"))
        with self.assertRaisesRegex(ValueError, "unverified.*no structured venue evidence"):
            validate_selected_venues([record], "ICML")

    def test_consistent_structured_fallback_is_valid(self):
        record = {"domain": "OpenReview.net", "invitation": "ICML.cc/2026/Conference/-/Decision",
                  "referrer": "https://openreview.net/group?id=ICML.cc%2F2026%2FConference",
                  "content": {"subject": "A paper about EMNLP"}}
        validate_selected_venues([record], "ICML")

    def test_unparseable_domain_is_not_hidden_by_other_metadata(self):
        record = {"domain": "EMNLP", "invitation": "ICML.cc/2026/Conference/-/Decision"}
        with self.assertRaisesRegex(ValueError, "cannot verify the domain"):
            validate_selected_venues([record], "ICML")

    def test_acronyms_are_exact_and_joint_names_are_supported(self):
        validate_selected_venues([{"domain": "aclweb.org/AACL-IJCNLP/2026/Conference"}], "AACL")
        for domain in ["eacl.org/EACL/2026/Conference", "aclweb.org/ACL/ARR/2026/May"]:
            with self.assertRaises(ValueError):
                validate_selected_venues([{"domain": domain}], "ACL")

    def test_main_stops_before_any_output_even_if_initial_filter_leaks(self):
        leaked = {"id": "leaked", "domain": "ICLR.cc/2026/Conference",
                  "content": {"subject": "Decision", "text": "Decision: Accept"}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "notifications.json"
            path.write_text("[]", encoding="utf-8")
            for mode in ["text", "json", "notifications"]:
                with self.subTest(mode=mode):
                    out, err = io.StringIO(), io.StringIO()
                    with patch("parse_notifications.filter_notifications", return_value=[leaked]), \
                            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        code = main(["2026-01-01", "ICML", "--input", str(path), "--format", mode])
                    self.assertEqual(code, 1)
                    self.assertEqual(out.getvalue(), "")
                    self.assertIn("Final venue check failed", err.getvalue())
                    self.assertIn("leaked", err.getvalue())


if __name__ == "__main__":
    unittest.main()
