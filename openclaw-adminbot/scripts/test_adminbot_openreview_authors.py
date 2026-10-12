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


class PaperAuthorsTests(unittest.TestCase):
    def lookup(self, content=None, error=None):
        client = Mock(spec=["get_note"])
        client.get_note.return_value = SimpleNamespace(id="syntheticPaper", content=content)
        client.get_note.side_effect = error
        output = io.StringIO()
        with patch.object(bridge, "connect", return_value=client), contextlib.redirect_stdout(output):
            try:
                bridge.cmd_paper_authors(SimpleNamespace(id="syntheticPaper"))
            except SystemExit:
                pass
        client.get_note.assert_called_once_with("syntheticPaper")
        return json.loads(output.getvalue())

    def test_reads_v2_author_identifiers(self):
        result = self.lookup({
            "title": {"value": "Synthetic paper"},
            "authors": {"value": ["Test Author"]},
            "authorids": {"value": ["~Test_Author1", "test@example.invalid"]},
        })
        self.assertEqual(result["authorids"], ["~Test_Author1", "test@example.invalid"])
        self.assertTrue(result["authorids_available"])

    def test_missing_fields_do_not_invent_identifiers(self):
        result = self.lookup({"authors": {"value": ["Anonymous"]}})
        self.assertIsNone(result["authorids"])
        self.assertFalse(result["authorids_available"])

    def test_failed_lookup_does_not_report_success_or_leak_exception(self):
        result = self.lookup(error=RuntimeError("private response"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "paper_unreadable")
        self.assertNotIn("private response", json.dumps(result))

    def test_missing_credentials(self):
        output = io.StringIO()
        with patch.dict(bridge.os.environ, {}, clear=True), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit):
                bridge.connect()
        self.assertEqual(json.loads(output.getvalue())["reason"], "no_credentials")


if __name__ == "__main__":
    unittest.main()
