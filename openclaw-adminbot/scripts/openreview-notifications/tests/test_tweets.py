import random
import unittest

from openreview_notifications.tweets import TEMPLATES, format_notifications


def notification(title="A Study of Reasoning", domain="NeurIPS.cc/2026/Conference", ident="n1", url=""):
    return {"id": ident, "domain": domain, "content": {
        "subject": f"Decision notification for your submission 123: {title}",
        "text": f'Your submission, "{title}", has been accepted.\n\n{url}'}}


class TweetTests(unittest.TestCase):
    def test_distinct_templates(self):
        texts = set()
        for number in TEMPLATES:
            draft = format_notifications([notification(url="https://openreview.net/forum?id=abc")], number)[0][0]
            self.assertEqual(draft["template"], number)
            self.assertEqual(draft["paper_count"], 1)
            text = draft["text"]
            self.assertIn("A Study of Reasoning", text)
            self.assertIn("#NeurIPS2026", text)
            opening, papers, *closings, mentions = text.split("\n\n")
            self.assertIn("#NeurIPS2026", opening)
            self.assertNotRegex(opening + "".join(closings), r"[-–—]")
            self.assertEqual(papers, "1. A Study of Reasoning (Main conference)")
            self.assertLessEqual(len(closings), 1)
            self.assertNotIn("\n", "".join(closings))
            self.assertNotIn("\n\n\n", text)
            self.assertEqual(mentions, '@MPI_IS @ELLISforEurope @UofTCompSci @VectorInst @TorontoSRI @CIFAR_News @JinesisLab @EuroSafeAI @ELLISInst_Tue')
            texts.add(text)
        self.assertEqual(len(texts), len(TEMPLATES))

    def test_one_random_template_per_run(self):
        records = [notification(domain=f"ICML.cc/{year}/Conference") for year in range(2020, 2025)]
        chosen = [d["template"] for d in format_notifications(records, rng=random.Random(42))[0]]
        self.assertEqual(len(set(chosen)), 1)
        other = format_notifications(records, rng=random.Random(7))[0][0]["template"]
        self.assertNotEqual(chosen[0], other)

    def test_duplicate_confirmation_does_not_inflate_count(self):
        records = [notification(), notification(ident="n2", url="https://openreview.net/forum?id=abc&noteId=review")]
        draft = format_notifications(records, 1)[0][0]
        self.assertEqual(draft["paper_count"], 1)
        self.assertEqual(draft["papers"][0]["notification_ids"], ["n1", "n2"])
        self.assertEqual(draft["papers"][0]["url"], "https://openreview.net/forum?id=abc")

    def test_tracks_combine_but_years_stay_separate(self):
        domains = ["NeurIPS.cc/2026/Conference", "NeurIPS.cc/2026/Workshop/TAE",
                   "NeurIPS.cc/2026/Position_Paper_Track", "NeurIPS.cc/2025/Conference"]
        announcements, skipped = format_notifications([notification(domain=d) for d in domains], 1)
        self.assertEqual(len(announcements), 2)
        self.assertEqual(announcements[0]["paper_count"], 3)
        self.assertEqual([p["track"] for p in announcements[0]["papers"]],
                         ["Main conference", "Position Paper Track", "TAE workshop"])
        self.assertIn("#NeurIPS2026 and its workshops", announcements[0]["text"])

    def test_five_papers_form_one_labeled_announcement(self):
        tracks = ["Workshop/TAE", "Position_Paper_Track", "Conference", "Conference", "Conference"]
        records = [notification(title=f"Paper {i}", domain=f"NeurIPS.cc/2026/{track}", ident=str(i))
                   for i, track in enumerate(tracks)]
        for template in TEMPLATES:
            with self.subTest(template=template):
                announcements, skipped = format_notifications(records, template)
                self.assertEqual(skipped, [])
                self.assertEqual(len(announcements), 1)
                announcement = announcements[0]
                self.assertEqual(announcement["paper_count"], 5)
                self.assertEqual([p["title"] for p in announcement["papers"]],
                                 ["Paper 2", "Paper 3", "Paper 4", "Paper 1", "Paper 0"])
                text = announcement["text"]
                self.assertEqual(text.count("(Main conference)"), 3)
                self.assertEqual(text.count("(Position Paper Track)"), 1)
                self.assertEqual(text.count("(TAE workshop)"), 1)
                self.assertEqual(text.count("#NeurIPS2026"), 1)
                self.assertNotIn("===", text)
                self.assertNotIn("---", text)

    def test_title_from_body_and_workshop_subject(self):
        record = notification()
        record["content"]["subject"] = "Decision notification"
        self.assertEqual(format_notifications([record], 1)[0][0]["papers"][0]["title"], "A Study of Reasoning")
        record["content"]["subject"] = "Acceptance Notification for A Study of Reasoning"
        record["content"]["text"] = "Your paper has been accepted."
        self.assertEqual(format_notifications([record], 1)[0][0]["papers"][0]["title"], "A Study of Reasoning")

    def test_ambiguous_or_unrelated_links_omitted(self):
        record = notification(url="https://example.org/form https://openreview.net/forum?id=a https://openreview.net/forum?id=b")
        self.assertIsNone(format_notifications([record], 1)[0][0]["papers"][0]["url"])

    def test_long_announcement_is_not_split_or_truncated(self):
        title = "研究" * 200 + " " + "long title " * 40
        record = notification(title=title.strip())
        record["content"]["text"] = "Decision: Accept"
        announcement = format_notifications([record], 1)[0][0]
        self.assertIn(title.strip(), announcement["text"])
        self.assertNotIn("---", announcement["text"])
        self.assertNotIn("===", announcement["text"])

    def test_invalid_input_fails_instead_of_silently_skipping(self):
        for records in [{}, [None], [{"content": {"text": "Decision: Reject"}}]]:
            with self.assertRaises(ValueError):
                format_notifications(records)
        record = notification()
        record["content"] = {"subject": "Decision", "text": "Decision: Accept"}
        drafts, skipped = format_notifications([record])
        self.assertEqual(drafts, [])
        self.assertIn("Cannot extract paper title", skipped[0])
        drafts, skipped = format_notifications([notification(domain="OpenReview.net/Support")])
        self.assertEqual(drafts, [])
        self.assertIn("Cannot identify venue/year", skipped[0])

    def test_empty_input_and_invalid_template(self):
        self.assertEqual(format_notifications([]), ([], []))
        with self.assertRaises(ValueError):
            format_notifications([], max(TEMPLATES) + 1)

    def test_common_openreview_title_formats(self):
        record = notification()
        record["content"] = {
            "subject": '[ICLR Workshop] The decision for your submission #7, titled "Reasoning, Then Acting" is now available',
            "text": "Decision: Accept",
        }
        drafts, skipped = format_notifications([record], 1)
        self.assertEqual(drafts[0]["papers"][0]["title"], "Reasoning, Then Acting")
        self.assertEqual(skipped, [])

        record["content"] = {
            "subject": "Acceptance Notification",
            "text": 'Your submission "Reasoning Under Uncertainty" to the AI4Physics workshop has been accepted.',
        }
        drafts, skipped = format_notifications([record], 1)
        self.assertEqual(drafts[0]["papers"][0]["title"], "Reasoning Under Uncertainty")
        self.assertEqual(skipped, [])
        record["domain"] = "EMNLP/2026/Conference"
        record["content"] = {
            "subject": "[EMNLP 2026] Decision Notification for Submission 212",
            "text": "Your submission to EMNLP 2026, Reasoning, Then Acting, has been accepted as a Findings paper.",
        }
        drafts, skipped = format_notifications([record], 1)
        self.assertEqual(drafts[0]["papers"][0]["title"], "Reasoning, Then Acting")
        self.assertEqual(drafts[0]["papers"][0]["track"], "Findings")
        self.assertEqual(skipped, [])

    def test_nested_venue_domains_and_findings_statistics(self):
        for domain, expected in [
            ("aclweb.org/ACL/2026/Conference", "#ACL2026"),
            ("eacl.org/EACL/2026/Conference", "#EACL2026"),
            ("cclear.cc/CLeaR/2026/Conference", "#CLeaR2026"),
        ]:
            record = notification(domain=domain)
            record["content"]["text"] += " We accepted 500 papers to Findings. Every paper accepted as a Findings paper has a separate deadline."
            drafts, skipped = format_notifications([record], 1)
            self.assertEqual(drafts[0]["venue"], expected)
            self.assertEqual(skipped, [])

    def test_different_forum_ids_override_identical_titles(self):
        records = [notification(url=f"https://openreview.net/forum?id={ident}") for ident in ("a", "b")]
        drafts, _ = format_notifications(records, 1)
        self.assertEqual(drafts[0]["paper_count"], 2)

    def test_malformed_links_and_quoted_metadata_are_ignored(self):
        record = notification(url="https://[invalid https://www.openreview.net/forum?id=abc&amp;noteId=review")
        record["content"]["text"] += "\n> https://openreview.net/forum?id=old"
        drafts, _ = format_notifications([record], 1)
        self.assertEqual(drafts[0]["papers"][0]["url"], "https://openreview.net/forum?id=abc")
        record["content"] = {"subject": "Reminder", "text": 'Your paper has been accepted.\n> Title: An unrelated paper'}
        drafts, skipped = format_notifications([record], 1)
        self.assertEqual(drafts, [])
        self.assertTrue(skipped)

    def test_unfilled_email_template_is_not_a_paper_title(self):
        record = notification(title="{{SubmissionTitle}}")
        drafts, skipped = format_notifications([record], 1)
        self.assertEqual(drafts, [])
        self.assertIn("placeholder", skipped[0])



if __name__ == "__main__":
    unittest.main()
