import contextlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "adminbot_openreview", Path(__file__).with_name("adminbot-openreview.py")
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def note(id, invitations=(), forum=None, **content):
    return SimpleNamespace(id=id, forum=forum or id, number=1, invitations=list(invitations),
                           content={key: {"value": value} for key, value in content.items()})


class OutcomeTests(unittest.TestCase):
    def test_reply_kinds_follow_invitation_suffixes(self):
        self.assertEqual(bridge.reply_kind(["ICLR.cc/2026/Conference/Submission1/-/Official_Review"]), "review")
        self.assertEqual(bridge.reply_kind(["aclweb.org/ACL/ARR/2026/May/Submission9/-/Meta_Review"]), "meta_review")
        self.assertEqual(bridge.reply_kind(["ICLR.cc/2026/Conference/Submission1/-/Decision"]), "decision")
        self.assertIsNone(bridge.reply_kind(["ICLR.cc/2026/Conference/Submission1/-/Official_Comment"]))

    def test_scores_read_numbers_and_numbered_labels(self):
        self.assertEqual(bridge.score_of(6), 6.0)
        self.assertEqual(bridge.score_of("3.5: borderline"), 3.5)
        self.assertIsNone(bridge.score_of("Strong paper"))
        self.assertIsNone(bridge.score_of(True))

    def test_outcomes(self):
        cases = [
            ("ICLR 2026 Oral", "ICLR.cc/2026/Conference", None, ("accepted", "main", "oral")),
            ("EMNLP 2026 Findings", "EMNLP/2026/Conference", None, ("accepted", "findings", None)),
            ("Submitted to ICLR 2027", "ICLR.cc/2027/Conference/Submission", None, ("under_review", None, None)),
            ("", "ICLR.cc/2026/Conference/Rejected_Submission", "Reject", ("rejected", None, None)),
            ("", "ICLR.cc/2026/Conference/Withdrawn_Submission", None, ("withdrawn", None, None)),
            ("", "ICLR.cc/2026/Conference/Desk_Rejected_Submission", None, ("desk_rejected", None, None)),
            ("Submitted to NeurIPS 2026", "x/Submission", "Accept (spotlight)", ("accepted", "main", "spotlight")),
            ("NeurIPS 2026 Workshop LLM Agents", "NeurIPS.cc/2026/Workshop", None, ("accepted", None, None)),
            ("MoralNLP 2026 Workshop", "EMNLP/2026/Workshop/MoralNLP", None, ("accepted", None, None)),
            ("EMNLP 2026 Main", "EMNLP/2026/Conference", "Accept to Main Conference Oral", ("accepted", "main", "oral")),
        ]
        for label, venue_id, decision, expected in cases:
            outcome = bridge.outcome_of(label, venue_id, decision)
            self.assertEqual((outcome["status"], outcome["track"], outcome["presentation"]), expected, label)


class AuthorResultsTests(unittest.TestCase):
    def test_follows_commitment_link_and_copies_only_scores(self):
        submission = note("emnlpNote", title="Synthetic", venue="EMNLP 2026 Findings", venueid="EMNLP/2026/Conference",
                          paper_link="https://openreview.net/forum?id=arrForum")
        comment = note("comment1", ["x/-/Official_Comment"], comment="no title, not a submission")
        replies = {
            "arrForum": [
                note("r1", ["arr/-/Official_Review"], forum="arrForum", overall_assessment="3.5: good", summary="secret words"),
                note("r2", ["arr/-/Official_Review"], forum="arrForum", overall_assessment=4, soundness="4 = strong"),
                note("m1", ["arr/-/Meta_Review"], forum="arrForum", overall_assessment=3.5, metareview="secret words"),
            ],
            "emnlpNote": [],
        }
        client = Mock()
        client.profile = SimpleNamespace(id="~Synthetic_PI1")

        def get_all_notes(content=None, forum=None):
            return [submission, comment] if content else replies[forum]

        client.get_all_notes.side_effect = get_all_notes
        output = io.StringIO()
        with patch.object(bridge, "connect", return_value=client), contextlib.redirect_stdout(output):
            bridge.cmd_author_results(SimpleNamespace())
        result = json.loads(output.getvalue())
        self.assertTrue(result["ok"])
        [entry] = result["submissions"]
        self.assertEqual(entry["review_forum"], "arrForum")
        self.assertEqual((entry["status"], entry["track"]), ("accepted", "findings"))
        self.assertEqual(entry["reviews"], [{"overall_assessment": 3.5}, {"overall_assessment": 4.0, "soundness": 4.0}])
        self.assertEqual(entry["meta_review"], {"overall_assessment": 3.5})
        self.assertNotIn("secret words", output.getvalue())

    def results(self, notes, replies, edits=None):
        client = Mock()
        client.profile = SimpleNamespace(id="~Synthetic_PI1")
        client.get_all_notes.side_effect = lambda content=None, forum=None: notes if content else replies.get(forum, [])
        client.get_note_edits.side_effect = lambda note_id: (edits or {}).get(note_id, [])
        output = io.StringIO()
        with patch.object(bridge, "connect", return_value=client), contextlib.redirect_stdout(output):
            bridge.cmd_author_results(SimpleNamespace())
        return json.loads(output.getvalue())["submissions"]

    def test_folds_the_arr_submission_into_its_commitment(self):
        arr = note("arrForum", title="Old Name", venue="ACL ARR 2026 May Submission",
                   venueid="aclweb.org/ACL/ARR/2026/May/Submission")
        arr.cdate = 1_746_000_000_000
        emnlp = note("emnlpNote", title="New Name", venue="EMNLP 2026 Main", venueid="EMNLP/2026/Conference",
                     paper_link="https://openreview.net/forum?id=arrForum")
        decision = note("d1", ["EMNLP/2026/Conference/Submission3/-/Decision"], forum="emnlpNote",
                        decision="Accept to Main Conference", presentation_mode="Poster")
        [entry] = self.results([arr, emnlp], {"emnlpNote": [decision]})
        # The ARR note alone would read "under review" for good; the commitment is what happened.
        self.assertEqual(entry["forum"], "emnlpNote")
        self.assertEqual((entry["status"], entry["track"], entry["presentation"]), ("accepted", "main", "poster"))
        self.assertEqual(entry["titles"], ["New Name", "Old Name"])
        self.assertEqual(entry["arr_venue_id"], "aclweb.org/ACL/ARR/2026/May/Submission")
        self.assertIsNone(entry["submitted_at"])
        [alone] = self.results([arr], {})
        self.assertEqual((alone["status"], alone["submitted_at"]), ("under_review", "2025-04-30T08:00:00+00:00"))

    def test_keeps_every_title_from_the_edit_history(self):
        paper = note("iclr1", title="Camera Ready Title", venue="ICLR 2026 Poster", venueid="ICLR.cc/2026/Conference")
        edits = {"iclr1": [
            SimpleNamespace(tcdate=1, note=SimpleNamespace(content={"title": {"value": "Submitted Title"}})),
            SimpleNamespace(tcdate=2, note=SimpleNamespace(content={"pdf": {"value": "/pdf/x.pdf"}})),
            SimpleNamespace(tcdate=3, note=SimpleNamespace(content={"title": {"value": "Camera Ready Title"}})),
        ]}
        [entry] = self.results([paper], {}, edits)
        self.assertEqual(entry["titles"], ["Camera Ready Title", "Submitted Title"])

    def test_stage_proofs_come_only_from_replies_the_author_can_see(self):
        paper = note("iclr1", title="T", venue="Submitted to ICLR 2027", venueid="ICLR.cc/2027/Conference/Submission")
        paper.signatures = ["ICLR.cc/2027/Conference/Submission1/Authors"]
        review = note("r1", ["ICLR.cc/2027/Conference/Submission1/-/Official_Review"], forum="iclr1", rating=6)
        review.cdate = 1_762_000_000_000
        later_review = note("r2", ["ICLR.cc/2027/Conference/Submission1/-/Official_Review"], forum="iclr1", rating=5)
        later_review.cdate = 1_762_100_000_000
        reviewer_comment = note("c1", ["ICLR.cc/2027/Conference/Submission1/-/Official_Comment"], forum="iclr1")
        reviewer_comment.signatures = ["ICLR.cc/2027/Conference/Submission1/Reviewer_ab12"]
        reviewer_comment.cdate = 1_762_200_000_000
        # Only reviews are visible: the submission note is signed by the authors, but it is not a
        # response, and nothing says whether a rebuttal is due.
        [entry] = self.results([paper], {"iclr1": [paper, later_review, review, reviewer_comment]})
        self.assertEqual(entry["stages"], {"reviews_out": "2025-11-01T12:26:40+00:00"})

        response = note("c2", ["ICLR.cc/2027/Conference/Submission1/-/Official_Comment"], forum="iclr1")
        response.signatures = ["ICLR.cc/2027/Conference/Submission1/Authors"]
        response.cdate = 1_762_300_000_000
        decision = note("d1", ["ICLR.cc/2027/Conference/Submission1/-/Decision"], forum="iclr1", decision="Reject")
        decision.cdate = 1_762_400_000_000
        [entry] = self.results([paper], {"iclr1": [paper, review, response, decision]})
        self.assertEqual(set(entry["stages"]), {"reviews_out", "rebuttal", "decision"})
        self.assertEqual(entry["stages"]["rebuttal"], "2025-11-04T23:46:40+00:00")

    def test_rebuttal_invitations_and_meta_reviews_account_for_the_window(self):
        self.assertEqual(bridge.reply_kind(["ICML.cc/2026/Conference/Submission4/-/Rebuttal"]), "rebuttal")
        arr = note("arrForum", title="T", venue="ACL ARR 2026 May Submission",
                   venueid="aclweb.org/ACL/ARR/2026/May/Submission")
        meta = note("m1", ["aclweb.org/ACL/ARR/2026/May/Submission9/-/Meta_Review"], forum="arrForum",
                    overall_assessment=3)
        [entry] = self.results([arr], {"arrForum": [meta]})
        self.assertEqual(entry["stages"], {"rebuttal": ""})

    def test_unreadable_forum_keeps_the_submission(self):
        client = Mock()
        client.profile = SimpleNamespace(id="~Synthetic_PI1")
        client.get_all_notes.side_effect = lambda content=None, forum=None: (
            [note("iclr1", title="T", venue="Submitted to ICLR 2027", venueid="ICLR.cc/2027/Conference/Submission")]
            if content else (_ for _ in ()).throw(RuntimeError("forbidden")))
        output = io.StringIO()
        with patch.object(bridge, "connect", return_value=client), contextlib.redirect_stdout(output):
            bridge.cmd_author_results(SimpleNamespace())
        [entry] = json.loads(output.getvalue())["submissions"]
        self.assertEqual(entry["status"], "under_review")
        self.assertEqual(entry["error"], "forbidden")
        self.assertEqual(entry["stages"], {})


if __name__ == "__main__":
    unittest.main()
