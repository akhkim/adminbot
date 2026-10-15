"""Exercise the one public command as a user would, outside the project folder."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "parse_notifications.py"


class CommandTests(unittest.TestCase):
    def run_command(self, content, *options):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.json"
            source.write_text(content, encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(SCRIPT), "2026-09-01", "NeurIPS", "--input", str(source), *options],
                cwd=directory, capture_output=True, text=True,
            )

    def test_main_command_runs_the_whole_pipeline(self):
        row = {
            "id": "paper-1", "cdate": 1790000000000, "domain": "NeurIPS.cc/2026/Conference",
            "content": {"subject": "Decision notification for your submission 1: Example Paper",
                        "text": "Decision: Accept"},
        }
        result = self.run_command(json.dumps([row]), "--template", "10", "--format", "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        draft = json.loads(result.stdout)[0]
        self.assertEqual(draft["template"], 10)
        self.assertEqual(draft["papers"][0]["notification_ids"], ["paper-1"])

    def test_invalid_json_has_no_partial_output(self):
        result = self.run_command("{broken")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("Error:", result.stderr)

    def test_invalid_template_is_rejected(self):
        result = self.run_command("[]", "--template", "11")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_input_path_is_required(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "2026-09-01", "NeurIPS"], capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--input", result.stderr)
