import unittest

from openreview_notifications.messages import extract_links


class MessageTests(unittest.TestCase):
    def test_links_are_deduplicated_and_host_checked(self):
        text = (
            'See (https://openreview.net/forum?id=abc&amp;noteId=review1). '
            'https://openreview.net/forum?id=abc&noteId=review1 '
            'https://openreview.net/pdf?id=paper2 '
            'https://openreview.net.evil.test/forum?id=bad '
            'https://openreview.net/profile?id=~Reader1'
        )
        urls, forums, notes = extract_links(text)
        self.assertEqual(forums, ["abc"])
        self.assertEqual(notes, ["review1", "paper2"])
        self.assertEqual(len(urls), 3)
