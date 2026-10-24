"""AdminBot adapter: submission and decision evidence for the paper OpenReview sync.

Reads the PI's notification export (stdin JSON {"notifications_csv": "..."}) and prints one
evidence item per submission of hers that the export says was submitted, accepted, rejected,
desk rejected or withdrawn.

It reads the export exactly as the paper sheet does: the CSV parser is adminbot_csv's, and the
outcomes are the sheet exporter's own notification_results (scripts/adminbot-sheet-export.py),
which settles each submission on its deciding message and ignores mail to her as a reviewer or
chair. This file only reshapes those outcomes for the service, so the sheet and AdminBot cannot
read the same mailbox two different ways.
"""
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from adminbot_csv import parse_notifications_csv

EXPORTER = Path(__file__).resolve().parent.parent / "adminbot-sheet-export.py"


def sheet_exporter():
    spec = importlib.util.spec_from_file_location("adminbot_sheet_export", EXPORTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def iso(milliseconds):
    if not milliseconds:
        return ""
    return datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc).isoformat(timespec="seconds")


def evidence_items(records, exporter=None):
    exporter = exporter or sheet_exporter()
    items = []
    for entry in exporter.notification_results(records):
        items.append({
            # The sheet keys a submission it has no forum for by title and venue; that is a
            # reference, not a forum id, so only a real forum is passed on as one.
            "reference": entry.get("id") or "",
            "observed_at": iso(entry.get("date")),
            "status": entry.get("status") or "",
            "title": entry.get("title") or "",
            "forum": entry.get("forum") or "",
            "venue_id": entry.get("venue_id") or "",
            "track": entry.get("track") or "",
            "presentation": entry.get("presentation") or "",
        })
    return {"ok": True, "evidence": items}


def run(request):
    records = (parse_notifications_csv(request["notifications_csv"])
               if "notifications_csv" in request else request.get("notifications"))
    if not isinstance(records, list):
        raise ValueError("Expected notifications_csv text or a notifications array.")
    return evidence_items(records)


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
