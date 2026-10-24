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


if __name__ == "__main__":
    unittest.main()
