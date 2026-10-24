import csv
import io
import unittest

from adminbot_decisions import run

HEADER = "id,date_utc,to,from_name,from_email,venue_domain,invitation,subject,status,message\n"


def row(identifier, date, domain, subject, message):
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerow(
        [identifier, date, "pi@example.org", "OpenReview", "noreply@openreview.net", domain, "", subject, "sent", message])
    return out.getvalue()


def posted(identifier, date, venue, title, forum, domain):
    return row(identifier, date, domain, f"{venue} has received your submission titled {title}",
               f"Your submission to {venue} has been posted.\nSubmission Number: 1\nTitle: {title}\n"
               f"https://openreview.net/forum?id={forum}")


class DecisionEvidenceTests(unittest.TestCase):
    def test_reads_the_export_the_way_the_sheet_does(self):
        csv_text = HEADER + "".join([
            posted("n1", "2026-10-10 12:00:00", "ARR - October 2026", "Synthetic Study", "Abc123",
                   "aclweb.org/ACL/ARR/2026/October"),
            posted("n2", "2026-05-20 08:00:00", "ARR - May 2026", "Findings Paper", "arrFindings",
                   "aclweb.org/ACL/ARR/2026/May"),
            row("n3", "2026-08-20 08:00:00", "EMNLP/2026/Conference",
                "[EMNLP 2026] Decision Notification for Submission 9",
                "Dear Authors, your submission to EMNLP 2026, Findings Paper, has been accepted as a Findings paper."),
            posted("n4", "2026-10-11 08:00:00", "ARR - October 2026", "Tutor Paper", "arrTutor",
                   "aclweb.org/ACL/ARR/2026/October"),
            row("n5", "2026-10-14 08:00:00", "aclweb.org/ACL/ARR/2026/October",
                "[ARR - October 2026]: Paper #13 desk-rejected by Program Chairs",
                'The paper "Tutor Paper" has been desk-rejected.\nhttps://openreview.net/forum?id=arrTutor'),
            # Mail to her as a reviewer: not her paper's outcome.
            row("n6", "2026-10-15 08:00:00", "aclweb.org/ACL/ARR/2026/October",
                "[ARR - October 2026]: Paper #77 withdrawn by paper authors",
                'The paper "Someone Else" has been withdrawn.\nhttps://openreview.net/forum?id=notMine'),
        ])
        result = run({"notifications_csv": csv_text})
        self.assertTrue(result["ok"])
        by_title = {item["title"]: item for item in result["evidence"]}
        self.assertEqual(set(by_title), {"Synthetic Study", "Findings Paper", "Tutor Paper"})
        self.assertEqual(by_title["Synthetic Study"]["status"], "under_review")
        self.assertEqual(by_title["Synthetic Study"]["forum"], "Abc123")
        self.assertEqual(by_title["Synthetic Study"]["venue_id"], "aclweb.org/ACL/ARR/2026/October")
        self.assertEqual(by_title["Synthetic Study"]["observed_at"], "2026-10-10T12:00:00+00:00")
        self.assertEqual((by_title["Findings Paper"]["status"], by_title["Findings Paper"]["track"]),
                         ("accepted", "findings"))
        self.assertEqual(by_title["Tutor Paper"]["status"], "desk_rejected")

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            run({"notifications": {}})


if __name__ == "__main__":
    unittest.main()
