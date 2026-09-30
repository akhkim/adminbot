"""AdminBot adapter; imported parser and renderer remain unchanged."""
import base64
import json
import sys
from pathlib import Path

from openreview_notifications.acceptance import classify_acceptance
from openreview_notifications.filters import filter_notifications, parse_min_date, validate_selected_venues
from openreview_notifications.tweets import format_notifications
from adminbot_authors import enrich
from adminbot_paper_links import recover_paper_links


def generate(request, directory):
    records = request.get("notifications")
    if not isinstance(records, list) or len(records) > 10000:
        raise ValueError("Upload a JSON array containing at most 10,000 notifications.")
    selected = filter_notifications(records, parse_min_date(request["min_date"]), request["conference"])
    selected = [record for record in selected if classify_acceptance(record).accepted]
    validate_selected_venues(selected, request["conference"])
    announcements, skipped = format_notifications(selected, request.get("template"))
    if selected and not announcements:
        raise ValueError("Accepted notifications were found, but their paper titles could not be identified.")
    papers = [paper for announcement in announcements for paper in announcement["papers"]]
    if len(papers) > 100 or sum(len(paper["title"]) + len(paper["track"]) for paper in papers) > 20000:
        raise ValueError("Too many papers for one generation. Use a later date to narrow the selection.")
    skipped.extend(recover_paper_links(announcements, selected, records))
    skipped.extend(enrich(announcements, request.get("members", [])))
    images = []
    if request.get("images", True) and announcements:
        from openreview_notifications.images import write_images
        for path in write_images(announcements, directory):
            images.append({"name": path.name, "data": base64.b64encode(path.read_bytes()).decode("ascii")})
    return {"announcements": announcements, "images": images, "warnings": skipped}


if __name__ == "__main__":
    try:
        print(json.dumps(generate(json.load(sys.stdin), Path(sys.argv[1])), ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
