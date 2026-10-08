"""Selection cases modeled on real notifications, with synthetic paper details."""
import unittest

from openreview_notifications.acceptance import classify_acceptance
from openreview_notifications.filters import filter_notifications, matches_conference, parse_min_date
from openreview_notifications.tweets import format_notifications


def notification(body, title="A Study of Reasoning", subject=None, **metadata):
    return {"domain": "EMNLP/2026/Conference", **metadata, "content": {
        "subject": subject or f"Decision notification for your submission 12: {title}",
        "text": body,
    }}


class SelectionRegressions(unittest.TestCase):
    def test_acceptances_are_not_lost_to_title_punctuation_or_keywords(self):
        titles = ["Can Models Reason? A Study", "Reasoning! A Study", "Dr. Model Explains",
                  "Conditional Cooperation", "What If Models Fail?", "Your Paper Is Accepted: A Benchmark"]
        for title in titles:
            for subject in [None, "[EMNLP 2026] Decision Notification for Submission 12"]:
                with self.subTest(title=title, subject=subject):
                    row = notification(
                        f"Your submission to EMNLP 2026, {title}, has been accepted as a Main Conference paper.",
                        title=title, subject=subject,
                    )
                    self.assertTrue(classify_acceptance(row).accepted)

    def test_rejection_with_title_punctuation_is_not_accepted(self):
        row = notification("Your submission to EMNLP 2026, Can Models Reason? A Study, was not accepted. We accepted 20% of papers.", title="Can Models Reason? A Study")
        self.assertEqual(classify_acceptance(row).status, "rejected")

    def test_conference_between_your_and_submission(self):
        for outcome, status in [("has been accepted", "accepted"), ("has not been accepted", "rejected")]:
            row = notification(f"Your ICML 2026 submission A Study of Reasoning {outcome} for presentation.")
            self.assertEqual(classify_acceptance(row).status, status)

    def test_later_conditional_instructions_do_not_cancel_final_acceptance(self):
        for separator in [".", "!"]:
            with self.subTest(separator=separator):
                row = notification(f"Your paper has been accepted{separator} If you need a visa, contact the organizers.")
                self.assertTrue(classify_acceptance(row).accepted)

    def test_quoted_and_forwarded_acceptances_do_not_count(self):
        for marker in ["-----Original Message-----", "---------- Forwarded message ---------", "Begin forwarded message:"]:
            row = notification(f"Please check the update below.\n{marker}\nYour paper has been accepted.")
            self.assertFalse(classify_acceptance(row).accepted)
        row = notification('The email would say "your paper has been accepted" if successful.')
        self.assertFalse(classify_acceptance(row).accepted)

    def test_conditional_or_conflicting_decisions_never_count(self):
        bodies = [
            "Decision: Accept\nComment: This is a conditional acceptance pending changes.",
            "Decision: Accept\nComment: We recommend acceptance subject to revision.",
            "Your paper has been accepted subject to a successful revision.",
            "Decision: Accept\nDecision: Reject",
            "Your paper was accepted, but its acceptance has been revoked.",
            "Your paper has been accepted for review, not publication.",
            "Your paper has been accepted?",
        ]
        for body in bodies:
            with self.subTest(body=body):
                self.assertFalse(classify_acceptance(notification(body)).accepted)

    def test_statistics_and_unannounced_decisions_never_count(self):
        for body in [
            "We accepted 100 papers. Your decision is available on OpenReview.",
            "For accepted papers, please upload the camera-ready version.",
            "Your paper is under review. Another paper has been accepted.",
            "Your paper has a review that says: Decision: Accept",
        ]:
            with self.subTest(body=body):
                self.assertFalse(classify_acceptance(notification(body)).accepted)

    def test_formatting_does_not_change_the_decision(self):
        cases = [
            ("Your paper has been accepted.", True),
            ("Your paper has not been accepted.", False),
            ("Decision: Accept (Poster)", True),
            ("Decision: Conditional Accept", False),
            ("Decision: Reject", False),
        ]
        for body, accepted in cases:
            variants = [body, body.upper(), body.lower(), body.replace(" ", "\n"),
                        body.replace(" ", "\r\n"), body.replace("accepted", "**accepted**")]
            for variant in variants:
                with self.subTest(body=variant):
                    self.assertEqual(classify_acceptance(notification(variant)).accepted, accepted)

    def test_hypothetical_instructions_do_not_override_explicit_decision(self):
        row = notification("Decision: Accept\n\nIf your paper has been accepted, upload the final version.")
        self.assertTrue(classify_acceptance(row).accepted)

    def test_title_is_not_itself_evidence_of_acceptance(self):
        row = notification(
            "Your submission to EMNLP 2026, Your Paper Is Accepted: A Benchmark, is still under review.",
            title="Your Paper Is Accepted: A Benchmark",
        )
        self.assertFalse(classify_acceptance(row).accepted)

    def test_conference_matching_does_not_use_titles_or_workshop_names(self):
        row = notification("Decision: Accept", title="Lessons from EMNLP", domain="ICML.cc/2026/Workshop/EMNLP")
        self.assertFalse(matches_conference(row, "EMNLP"))
        self.assertTrue(matches_conference(row, "ICML"))

        row = notification("Decision: Accept", domain="OpenReview.net", invitation="ICML.cc/2026/Conference/-/Decision")
        row["content"]["subject"] = "[ICML 2026] Decision notification for your submission 1: Lessons from EMNLP"
        self.assertFalse(matches_conference(row, "EMNLP"))
        self.assertTrue(matches_conference(row, "ICML"))

    def test_arr_and_conflicting_metadata_are_not_assigned_to_a_conference(self):
        row = notification("Decision: Accept", domain="aclweb.org/ACL/ARR/2026/May")
        self.assertFalse(matches_conference(row, "ACL"))
        self.assertFalse(matches_conference(row, "EMNLP"))
        self.assertTrue(matches_conference(row, "ARR"))
        row = notification("Decision: Accept", domain="OpenReview.net/Support/",
                           invitation="ICML.cc/2026/Conference/-/Decision",
                           signature="ICLR.cc/2026/Conference/Program_Chairs")
        for conference in ["ICML", "ICLR", "EMNLP"]:
            self.assertFalse(matches_conference(row, conference))

    def test_structured_referrer_takes_precedence_over_subject(self):
        row = notification("Decision: Accept", domain=None,
                           referrer="https://openreview.net/group?id=ICML.cc%2F2026%2FConference")
        row["content"]["subject"] = "EMNLP comparison"
        self.assertTrue(matches_conference(row, "ICML"))
        self.assertFalse(matches_conference(row, "EMNLP"))

    def test_full_selection_uses_date_venue_and_decision_together(self):
        cutoff = parse_min_date("2026-09-01")
        records = [
            notification("Your submission to EMNLP 2026, Why Reason? A Study, has been accepted as a Findings paper.", title="Why Reason? A Study"),
            notification("Decision: Reject"),
            notification("Decision: Accept\nComment: This is a conditional acceptance."),
            notification("Decision: Accept", domain="ICML.cc/2026/Conference"),
            notification("Decision: Accept"),
            notification("Decision: Accept"),
        ]
        for index, record in enumerate(records):
            record.update(id=str(index), cdate=cutoff + 1)
        records[4]["cdate"] = cutoff
        records[5]["cdate"] = cutoff - 1
        selected = [r for r in filter_notifications(records, cutoff, "EMNLP") if classify_acceptance(r).accepted]
        self.assertEqual([r["id"] for r in selected], ["0"])
        drafts, skipped = format_notifications(selected, 1)
        self.assertEqual(skipped, [])
        self.assertEqual(drafts[0]["venue"], "#EMNLP2026")
        self.assertEqual(drafts[0]["papers"][0]["track"], "Findings")
        self.assertEqual(drafts[0]["paper_count"], 1)


if __name__ == "__main__":
    unittest.main()
