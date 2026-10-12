import unittest
from adminbot_arxiv import add_arxiv_links


class ArxivTests(unittest.TestCase):
    def announcement(self):
        return [{"text": "Opening\n\n1. Study (Main)\n\nAuthors: @example",
                 "papers": [{"title": "Study", "track": "Main",
                             "url": "https://openreview.net/forum?id=test"}]}]

    def test_exact_title_and_pdf_normalization(self):
        drafts = self.announcement()
        self.assertEqual(add_arxiv_links(drafts, [{"title": "STUDY", "arxiv_url":
            "https://arxiv.org/pdf/2601.12345v2.pdf"}]), [])
        self.assertIn("1. Study (Main) https://arxiv.org/abs/2601.12345v2", drafts[0]["text"])
        self.assertTrue(drafts[0]["text"].endswith("Authors: @example"))

    def test_id_takes_precedence_over_title(self):
        drafts = self.announcement()
        add_arxiv_links(drafts, [
            {"title": "Previous title", "submission_url": "https://openreview.net/pdf?id=test",
             "arxiv_url": "https://arxiv.org/abs/2601.12345"},
            {"title": "Study", "arxiv_url": "https://arxiv.org/abs/2601.99999"},
        ])
        self.assertIn("2601.12345", drafts[0]["text"])
        self.assertNotIn("2601.99999", drafts[0]["text"])

    def test_missing_ambiguous_invalid_and_conflicting_links_are_omitted(self):
        valid = {"title": "Study", "arxiv_url": "https://arxiv.org/abs/2601.12345"}
        for saved in ([], [valid, valid], [{**valid, "arxiv_url": "https://evil.test/2601.12345"}],
                      [{**valid, "submission_url": "https://openreview.net/forum?id=other"}]):
            with self.subTest(saved=saved):
                drafts = self.announcement()
                before = drafts[0]["text"]
                self.assertEqual(len(add_arxiv_links(drafts, saved)), 1)
                self.assertEqual(drafts[0]["text"], before)
