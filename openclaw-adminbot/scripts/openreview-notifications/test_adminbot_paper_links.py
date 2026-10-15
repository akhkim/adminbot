import unittest

from adminbot_paper_links import recover_paper_links


def record(subject, text="", domain="NeurIPS.cc/2026/Conference", id="decision"):
    return {"id": id, "domain": domain, "content": {"subject": subject, "text": text}}


class PaperLinkTests(unittest.TestCase):
    def resolve(self, others, url=None):
        decision = record("Decision notification for your submission 42: Synthetic Paper")
        paper = {"title": "Synthetic Paper", "url": url, "notification_ids": ["decision"]}
        warnings = recover_paper_links([{"papers": [paper]}], [decision], [decision, *others])
        return paper["url"], warnings

    def test_recovers_from_earlier_review_notification(self):
        other = record('Reviewer commented. Paper Number: 42, Paper Title: "Synthetic Paper"',
                       "https://openreview.net/forum?id=synthetic&noteId=review")
        other["cdate"] = 1
        self.assertEqual(self.resolve([other]), ("https://openreview.net/forum?id=synthetic", []))

    def test_never_crosses_year_or_track_or_submission(self):
        for domain, number in [("NeurIPS.cc/2025/Conference", 42),
                               ("NeurIPS.cc/2026/Workshop/Example", 42),
                               ("NeurIPS.cc/2026/Conference", 43)]:
            with self.subTest(domain=domain, number=number):
                self.assertEqual(self.resolve([record(f"Paper Number: {number}",
                    "https://openreview.net/forum?id=wrong", domain)]), (None, []))

    def test_conflicting_ids_are_rejected(self):
        url, warnings = self.resolve([record("Paper Number: 42", f"https://openreview.net/forum?id={id}")
                                      for id in ["first", "second"]])
        self.assertIsNone(url)
        self.assertIn("conflicting", warnings[0])

    def test_keeps_direct_links_and_ignores_quoted_links(self):
        other = record("Paper Number: 42", "> https://openreview.net/forum?id=quoted")
        self.assertEqual(self.resolve([other]), (None, []))
        self.assertEqual(self.resolve([other], "https://openreview.net/forum?id=direct"),
                         ("https://openreview.net/forum?id=direct", []))


if __name__ == "__main__":
    unittest.main()
