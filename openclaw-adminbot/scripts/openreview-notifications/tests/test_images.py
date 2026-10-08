import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from openreview_notifications.images import BOTTOM, LINE_HEIGHT, layout_papers, load_font, write_images
from parse_notifications import main

PILLOW = importlib.util.find_spec("PIL") is not None


def announcement(papers):
    return {"venue": "#NeurIPS2026", "papers": papers}


class ImageTests(unittest.TestCase):
    def test_empty_selection_creates_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "images"
            self.assertEqual(write_images([], target), [])
            self.assertFalse(target.exists())

    def test_missing_pillow_has_actionable_error(self):
        with patch.dict("sys.modules", {"PIL": None}):
            with self.assertRaisesRegex(ValueError, "requires Pillow"):
                write_images([announcement([])], "unused")

    @unittest.skipUnless(PILLOW, "optional Pillow dependency not installed")
    def test_long_titles_and_labels_paginate_without_loss(self):
        from PIL import ImageFont
        font, label_font = load_font(ImageFont, 38), load_font(ImageFont, 27)
        papers = [{"title": "A long paper title " * 250, "track": "Workshop " * 100},
                  {"title": "x" * 200, "track": "Main conference"}]
        pages = layout_papers(papers, font, label_font)
        self.assertGreater(len(pages), 1)
        actual = {1: [], 2: []}
        for page in pages:
            for number, y, rows in page:
                self.assertLessEqual(y + len(rows) * LINE_HEIGHT, BOTTOM)
                for line, label in rows:
                    self.assertLessEqual((label_font if label else font).getlength(line), 975)
                    actual[number].append(line)
        for number, paper in enumerate(papers, 1):
            expected = paper['title'] + '(' + paper['track'] + ')'
            self.assertEqual(''.join(''.join(actual[number]).split()), ''.join(expected.split()))

    @unittest.skipUnless(PILLOW, "optional Pillow dependency not installed")
    def test_images_have_titles_labels_and_no_links(self):
        from PIL import Image, ImageChops
        papers = [{"title": f"Paper {i}", "track": "TAE workshop", "url": "https://openreview.net/forum?id=x"}
                  for i in range(20)]
        with tempfile.TemporaryDirectory() as directory:
            paths = write_images([announcement(papers)], directory)
            self.assertGreater(len(paths), 1)
            descriptions = []
            for path in paths:
                with Image.open(path) as image:
                    self.assertEqual(image.format, "PNG")
                    self.assertEqual(image.width, 1200)
                    self.assertLessEqual(image.height, BOTTOM + 140)
                    background = Image.new("RGB", image.size, "#faf9f6")
                    content_bottom = ImageChops.difference(image, background).getbbox()[3]
                    bottom_margin = image.height - content_bottom
                    self.assertGreaterEqual(bottom_margin, 30)
                    self.assertLessEqual(bottom_margin, 85)
                    descriptions.append(image.info['Description'])
            text = '\n'.join(descriptions)
            for i in range(20):
                self.assertIn(f'{i + 1}. Paper {i} (TAE workshop)', text)
            self.assertNotIn('https://', text)

    @unittest.skipUnless(PILLOW, "optional Pillow dependency not installed")
    def test_cli_keeps_json_valid_and_reports_image_path(self):
        record = {"id": "a", "cdate": 1790000000000, "domain": "NeurIPS.cc/2026/Conference",
                  "content": {"subject": "Decision notification for your submission 1: Example Paper",
                              "text": "Decision: Accept"}}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'input.json'
            source.write_text(json.dumps([record]))
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(['2026-09-01', 'neurips', '--input', str(source), '--format', 'json',
                             '--images', str(Path(directory) / 'images')])
            self.assertEqual(code, 0, err.getvalue())
            self.assertEqual(json.loads(out.getvalue())[0]['paper_count'], 1)
            self.assertTrue((Path(directory) / 'images' / 'NeurIPS2026-1.png').is_file())
            self.assertIn('Image:', err.getvalue())

    def test_notification_only_mode_rejects_images(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            main(['2026-09-01', 'neurips', '--input', 'unused', '--images', 'unused', '--format', 'notifications'])
        self.assertEqual(error.exception.code, 2)
