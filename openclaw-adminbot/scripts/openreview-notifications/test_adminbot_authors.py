import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from adminbot_authors import author_ids, connect, enrich
from adminbot_bridge import generate


class AuthorTests(unittest.TestCase):
    def drafts(self):
        return [{"text": "Synthetic draft", "papers": [
            {"title": "Synthetic paper", "url": "https://openreview.net/forum?id=synthetic"},
            {"title": "Second listing", "url": "https://openreview.net/forum?id=synthetic"},
        ]}]

    def test_both_author_formats(self):
        self.assertEqual(author_ids({"authorids": {"value": ["~Test_Author1", "A@example.invalid"]},
            "authors": {"value": [{"username": "~Test_Author1"}, {"username": "~Other1"}]}}),
            ["~Test_Author1", "a@example.invalid", "~Other1"])

    def test_exact_matches_deduplicate_handles_and_cache_papers(self):
        client = Mock()
        client.get_note.return_value = SimpleNamespace(content={"authors": {"value": [
            {"username": "~Test_Author1"}, {"username": "~Other1"}]}})
        drafts = self.drafts()
        warnings = enrich(drafts, [
            {"openreview_id": "https://openreview.net/profile?id=~Test_Author1", "handle": "TestHandle"},
            {"openreview_id": "~Other1", "handle": "testhandle"},
        ], lambda: client)
        self.assertEqual(warnings, [])
        self.assertEqual(drafts[0]["text"].count("@TestHandle"), 1)
        client.get_note.assert_called_once_with("synthetic")

    def test_missing_ambiguous_and_invalid_handles_are_not_guessed(self):
        client = Mock()
        client.get_note.return_value = SimpleNamespace(content={"authorids": ["~A1", "~B1", "~C1"]})
        drafts = self.drafts()
        warnings = enrich(drafts, [
            {"openreview_id": "~A1", "handle": "first"},
            {"openreview_id": "~A1", "handle": "second"},
            {"openreview_id": "~B1", "handle": None},
        ], lambda: client)
        self.assertEqual(drafts[0]["text"], "Synthetic draft")
        self.assertTrue(any("multiple member" in w for w in warnings))
        self.assertTrue(any("no valid saved" in w for w in warnings))
        self.assertTrue(any("no matching member" in w for w in warnings))

    def test_unreadable_paper_is_reported_without_exception_details(self):
        client = Mock()
        client.get_note.side_effect = RuntimeError("private response")
        warnings = enrich(self.drafts(), [], lambda: client)
        self.assertEqual(len(warnings), 2)
        self.assertNotIn("private response", str(warnings))
        client.get_note.assert_called_once()

    def test_credentials_are_required(self):
        with patch.dict("os.environ", {}, clear=True), self.assertRaisesRegex(ValueError, "OPENREVIEW_USERNAME"):
            connect()

    def test_full_adapter_generates_handle_and_png(self):
        client = Mock()
        client.get_note.return_value = SimpleNamespace(content={"authorids": {"value": ["~Test_Author1"]}})
        request = {"min_date": "2026-09-01", "conference": "neurips", "template": 1,
            "paper_links": [{"title": "Synthetic Study", "arxiv_url": "https://arxiv.org/abs/2601.12345"}],
            "members": [{"openreview_id": "~Test_Author1", "handle": "TestHandle"}],
            "notifications": [{"id": "synthetic", "cdate": 1790000000000,
                "domain": "NeurIPS.cc/2026/Conference", "content": {
                    "subject": "Decision notification for your submission 1: Synthetic Study",
                    "text": "Decision: Accept\nhttps://openreview.net/forum?id=synthetic"}}]}
        with tempfile.TemporaryDirectory() as folder, patch("adminbot_bridge.enrich",
                side_effect=lambda drafts, members: enrich(drafts, members, lambda: client)):
            result = generate(request, Path(folder))
        self.assertIn("Authors: @TestHandle", result["announcements"][0]["text"])
        self.assertEqual(len(result["images"]), 1)
        self.assertEqual(result["warnings"], [])


if __name__ == "__main__":
    unittest.main()
