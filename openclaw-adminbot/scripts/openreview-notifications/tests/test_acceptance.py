import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from openreview_notifications.acceptance import classify_acceptance
from parse_notifications import main


def record(body, subject="[NeurIPS] Decision notification for your submission 1: Paper", domain="NeurIPS.cc/2026/Conference"):
    return {"id": "test", "cdate": 1790000000000, "domain": domain,
            "content": {"subject": subject, "text": body}}


class AcceptanceTests(unittest.TestCase):
    def test_explicit_acceptance_and_statistics(self):
        result = classify_acceptance(record('Your submission, "A paper", has been accepted as a poster. We rejected 70% of papers.'))
        self.assertTrue(result.accepted)
        self.assertEqual(result.rule, "explicit_paper_acceptance")

    def test_rejection_with_acceptance_statistics(self):
        result = classify_acceptance(record('Your paper was not selected for acceptance. We accepted 7900 papers.'))
        self.assertEqual(result.status, "rejected")
        self.assertFalse(classify_acceptance(record('Your paper has not been accepted. Congratulations to the accepted authors!')).accepted)

    def test_markdown_and_wrapped_lines(self):
        self.assertTrue(classify_acceptance(record('Your paper, **"Great work"**, has been\n**accepted**.')).accepted)
        self.assertTrue(classify_acceptance(record('Decision: **decision**: Accept (Poster)')).accepted)
        self.assertTrue(classify_acceptance(record('**decision**: Accept')).accepted)

    def test_not_review_recommendations_or_invitation_acceptances(self):
        for subject, text in [('Official Review posted', 'Decision: Accept\nI recommend acceptance.'),
                              ('Reviewer accepted to review paper 4', 'Your paper has been accepted.'),
                              ('An author commented on your paper', 'Your paper has been accepted.'),
                              ('Review invitation', 'Please accept this invitation.'),
                              ('A decision', 'Recommendation: Accept\nRating: 8: Accept')]:
            self.assertFalse(classify_acceptance(record(text, subject)).accepted)

    def test_statistics_and_unknown_decision(self):
        for text in ['We accepted 50 papers. Please check OpenReview for your decision.',
                     'Your decision is now available.', 'Congratulations to all accepted authors!',
                     'Accepted authors must upload camera-ready papers.']:
            self.assertEqual(classify_acceptance(record(text)).status, 'unknown')

    def test_non_paper_proposals(self):
        self.assertFalse(classify_acceptance(record('Your submission has been accepted.', domain='NeurIPS.cc/2026/Workshop_Proposals')).accepted)
        self.assertFalse(classify_acceptance(record('Decision: Accept', domain='EMNLP/2026/Tutorials')).accepted)
        self.assertTrue(classify_acceptance(record('Your paper has been accepted.', domain='NeurIPS.cc/2026/Workshop/TAE')).accepted)

    def test_conditional_and_conflicting_evidence(self):
        for text in ['If your paper has been accepted, upload your final version.',
                     'You can view your paper at the link. If your paper is accepted, upload it.',
                     'We recommend that your paper is accepted.',
                     'Your paper has been accepted pending revision.', 'Decision: Conditional Accept',
                     'Decision: Reject\n\nYour paper has been accepted.']:
            self.assertEqual(classify_acceptance(record(text)).status, 'unknown')

    def test_conditional_comment_and_trailing_condition(self):
        for body in [
            "**decision**: Accept\n**comment**: conditional acceptance, as per AC review",
            "Your paper has been accepted if the requested changes are made.",
        ]:
            self.assertFalse(classify_acceptance(record(body)).accepted)

    def test_title_is_not_a_notification_type(self):
        self.assertTrue(classify_acceptance(record(
            "Your paper has been accepted.",
            subject="Acceptance Notification for Comment on LLM Reasoning",
        )).accepted)

    def test_forwarded_quotes(self):
        self.assertFalse(classify_acceptance(record('> Your paper has been accepted.')).accepted)
        self.assertFalse(classify_acceptance(record('An update.\n-----Original Message-----\nYour paper has been accepted.')).accepted)

    def test_explicit_confirmation_and_active_voice(self):
        self.assertTrue(classify_acceptance(record('Congratulations on the acceptance of your submission to MRL!')).accepted)
        self.assertTrue(classify_acceptance(record('We are pleased to accept your paper.')).accepted)
        self.assertTrue(classify_acceptance(record('Congratulations again on the acceptance of your paper! Please upload the final version.')).accepted)

    def test_cli_returns_only_acceptances(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)/'input.json'
            accepted = record('Your paper has been accepted.')
            rejected = record('Your paper was not accepted.')
            source.write_text(json.dumps([accepted, rejected]))
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(['2026-09-01', 'neurips', '--input', str(source), '--format', 'notifications'])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue()), [accepted])
            self.assertEqual(err.getvalue(), '')
