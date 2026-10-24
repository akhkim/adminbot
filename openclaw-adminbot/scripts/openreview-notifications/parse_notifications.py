#!/usr/bin/env python3
"""Read OpenReview notifications, select acceptances, and produce tweet announcements."""
import argparse
import json
import sys
from pathlib import Path

from openreview_notifications.acceptance import classify_acceptance
from openreview_notifications.filters import filter_notifications, parse_min_date, validate_selected_venues
from openreview_notifications.tweets import TEMPLATES, format_notifications


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("min_date", help="Exclusive cutoff: YYYY-MM-DD (UTC) or an ISO timestamp with timezone")
    parser.add_argument("conference", help="Case-insensitive conference name: EMNLP, ICML, ICLR, NeurIPS, etc.")
    parser.add_argument("--input", type=Path, required=True, help="Path to the notifications JSON file")
    parser.add_argument("--template", type=int, choices=tuple(TEMPLATES), help="Template number (default: random)")
    parser.add_argument(
        "--format", choices=("text", "json", "notifications"), default="text",
        help="Output tweet text (default), tweet JSON, or accepted notification JSON",
    )
    parser.add_argument(
        "--all-notifications", action="store_true",
        help="Diagnostic mode: export all date/venue matches as JSON instead of tweets",
    )
    parser.add_argument("--images", type=Path, metavar="DIR", help="Also save paper lists as PNGs in DIR (requires Pillow)")
    args = parser.parse_args(argv)
    if args.images is not None and (args.all_notifications or args.format == "notifications"):
        parser.error("--images requires tweet output (--format text or json)")
    return args


def write_announcements(announcements, output_format):
    if output_format == "json":
        print(json.dumps(announcements, ensure_ascii=False, indent=2, allow_nan=False))
    elif announcements:
        print("\n\n".join(announcement["text"] for announcement in announcements))
    else:
        print("No accepted papers matched the date and conference.", file=sys.stderr)


def main(argv=None):
    args = parse_args(argv)
    try:
        cutoff = parse_min_date(args.min_date)
        with args.input.expanduser().open(encoding="utf-8-sig") as stream:
            records = json.load(stream)

        selected = filter_notifications(records, cutoff, args.conference)
        if not args.all_notifications:
            selected = [record for record in selected if classify_acceptance(record).accepted]
        validate_selected_venues(selected, args.conference)

        if args.all_notifications or args.format == "notifications":
            print(json.dumps(selected, ensure_ascii=False, indent=2, allow_nan=False))
            return 0

        announcements, skipped = format_notifications(selected, args.template)
        for warning in skipped:
            print(f"Skipped: {warning}", file=sys.stderr)
        if selected and not announcements:
            raise ValueError("No tweet announcements could be generated from the accepted notifications")
        if args.images is not None:
            from openreview_notifications.images import write_images
            for path in write_images(announcements, args.images):
                print(f"Image: {path.resolve()}", file=sys.stderr)
        write_announcements(announcements, args.format)
        return 0
    except (OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
