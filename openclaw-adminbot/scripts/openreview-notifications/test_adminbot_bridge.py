import importlib.util
import tempfile
import unittest
from pathlib import Path
from adminbot_bridge import generate


class BridgeTests(unittest.TestCase):
    def request(self):
        return {"min_date": "2026-09-01", "conference": "neurips", "template": 1,
                "notifications": [{"id": "synthetic", "cdate": 1790000000000,
                    "domain": "NeurIPS.cc/2026/Conference",
                    "content": {"subject": "Decision notification for your submission 1: Synthetic Study",
                                "text": "Decision: Accept"}}]}

    @unittest.skipUnless(importlib.util.find_spec("PIL"), "Pillow not installed")
    def test_png_and_draft(self):
        import base64
        with tempfile.TemporaryDirectory() as folder:
            result = generate(self.request(), Path(folder))
            self.assertEqual(result["announcements"][0]["paper_count"], 1)
            self.assertTrue(base64.b64decode(result["images"][0]["data"]).startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertIn("Synthetic Study", result["announcements"][0]["text"])

    def test_text_only_and_bad_input(self):
        with tempfile.TemporaryDirectory() as folder:
            result = generate({**self.request(), "images": False}, Path(folder))
            self.assertEqual(result["images"], [])
            with self.assertRaises(ValueError):
                generate({**self.request(), "notifications": {}}, Path(folder))

    @unittest.skipUnless(importlib.util.find_spec("PIL"), "Pillow not installed")
    def test_many_papers_produce_one_complete_image(self):
        import base64
        import io
        from PIL import Image
        request = self.request()
        original = request["notifications"][0]
        request["notifications"] = [
            {**original, "id": f"synthetic-{i}", "content": {
                "subject": f"Decision notification for your submission {i}: Synthetic Study {i}",
                "text": "Decision: Accept",
            }} for i in range(1, 21)
        ]
        with tempfile.TemporaryDirectory() as folder:
            result = generate(request, Path(folder))
            self.assertEqual(len(result["images"]), 1)
            with Image.open(io.BytesIO(base64.b64decode(result["images"][0]["data"]))) as image:
                self.assertGreater(image.height, 1380)
                for i in range(1, 21):
                    self.assertIn(f"Synthetic Study {i} (", image.info["Description"])

    @unittest.skipUnless(importlib.util.find_spec("PIL"), "Pillow not installed")
    def test_multiple_venues_share_one_image(self):
        from PIL import Image
        from adminbot_images import write_image
        with tempfile.TemporaryDirectory() as folder:
            path = write_image([
                {"venue": venue, "papers": [{"title": f"Study {venue}", "track": "Main"}]}
                for venue in ("Venue A", "Venue B")
            ], folder)
            self.assertEqual(len(list(Path(folder).glob("*.png"))), 1)
            with Image.open(path) as image:
                self.assertIn("Study Venue A", image.info["Description"])
                self.assertIn("Study Venue B", image.info["Description"])
