import unittest
from adminbot_csv import parse_notifications_csv

HEADER = "id,date_utc,venue_domain,subject,message\r\n"


class CsvTests(unittest.TestCase):
    def test_bom_quotes_commas_multiline_and_utc(self):
        records = parse_notifications_csv('\ufeff' + HEADER +
            'test,2026-09-01 00:00:00,NeurIPS.cc/2026/Conference,"Study, one","Line 1\nHe said ""yes"""\r\n')
        self.assertEqual(records[0]["cdate"], 1788220800000)
        self.assertEqual(records[0]["content"], {"subject": "Study, one", "text": 'Line 1\nHe said "yes"'})

    def test_invalid_rows(self):
        for text in ("id,message\na,b", HEADER + 'a,invalid,b,c,d',
                     HEADER + 'a,2026-09-01 00:00:00,b,c',
                     HEADER + 'a,2026-09-01 00:00:00,b,c,"unclosed',
                     HEADER.replace('message', 'subject')):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_notifications_csv(text)

    def test_empty_and_limit(self):
        self.assertEqual(parse_notifications_csv(HEADER), [])
        with self.assertRaisesRegex(ValueError, "10,000"):
            parse_notifications_csv(HEADER + 'a,2026-09-01 00:00:00,b,c,d\n' * 10001)
