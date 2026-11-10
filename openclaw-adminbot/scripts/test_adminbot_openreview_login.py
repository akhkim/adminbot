import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "adminbot_openreview", Path(__file__).with_name("adminbot-openreview.py")
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

# Synthetic credentials; OpenReviewClient is replaced below, so nothing reaches OpenReview.
CREDENTIALS = {"OPENREVIEW_USERNAME": "synthetic@example.test", "OPENREVIEW_PASSWORD": "synthetic"}


class OpenReviewException(Exception):
    pass


def fake_openreview(client):
    """A stand-in openreview package whose OpenReviewClient is `client`."""
    package = types.ModuleType("openreview")
    package.OpenReviewException = OpenReviewException
    api = types.ModuleType("openreview.api")
    api.OpenReviewClient = client
    package.api = api
    return {"openreview": package, "openreview.api": api}


def run_connect(client):
    sleep = Mock()
    stdout = io.StringIO()
    with patch.dict(os.environ, CREDENTIALS), patch.dict(sys.modules, fake_openreview(client)):
        with contextlib.redirect_stdout(stdout):
            try:
                result = bridge.connect(sleep=sleep)
            except SystemExit:
                result = json.loads(stdout.getvalue())
    return result, sleep


class ConnectTests(unittest.TestCase):
    def test_retries_a_dropped_connection_then_logs_in(self):
        logged_in = types.SimpleNamespace(profile=types.SimpleNamespace(id="~Synthetic1"))
        client = Mock(side_effect=[ConnectionError("reset"), logged_in])
        result, sleep = run_connect(client)
        self.assertIs(result, logged_in)
        self.assertEqual(client.call_count, 2)
        sleep.assert_called_once_with(bridge.LOGIN_RETRY_DELAYS_S[0])

    def test_a_refused_password_is_auth_failed_without_retrying(self):
        refused = OpenReviewException({"name": "Error", "message": "Invalid credentials", "status": 400})
        client = Mock(side_effect=refused)
        result, sleep = run_connect(client)
        self.assertEqual(result["reason"], "auth_failed")
        self.assertNotIn(CREDENTIALS["OPENREVIEW_PASSWORD"], json.dumps(result))
        self.assertEqual(client.call_count, 1)
        sleep.assert_not_called()

    def test_an_outage_is_not_reported_as_bad_credentials(self):
        busy = OpenReviewException({"name": "Error", "message": "Too many requests", "status": 429})
        client = Mock(side_effect=[TimeoutError("slow"), busy, busy])
        result, sleep = run_connect(client)
        self.assertEqual(result["reason"], "openreview_unavailable")
        self.assertEqual(client.call_count, len(bridge.LOGIN_RETRY_DELAYS_S) + 1)
        self.assertEqual(sleep.call_count, len(bridge.LOGIN_RETRY_DELAYS_S))


if __name__ == "__main__":
    unittest.main()
