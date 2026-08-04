#!/usr/bin/env python3
"""
Publish tracked submission deadlines to the Jinesis Lab Google Calendar.

Reads the same `venues.json` the deadline board and reminders use, and writes one all-day event
per venue deadline to `jinesis.lab@gmail.com`.

Two things make this safe to run repeatedly:

  * Every event carries a marker line in its description, `[adminbot-deadline:<venue id>]`. A run
    searches the calendar for that marker before creating anything, so re-running updates the
    existing event instead of stacking duplicates. The venue id is the key, not the title, so a
    renamed venue moves its own event rather than orphaning one.
  * Nothing is written without `--send`. The default prints the plan, matching every other script
    in the deadline set.

Deadlines are AoE (UTC-12). The event is placed on the *AoE calendar date* rather than the instant
converted into local time, because "the ICML deadline is the 15th" is what people act on; showing
it on the 16th because Toronto is ahead of AoE would be actively misleading.

Env:
  ADMINBOT_DEADLINE_CALENDAR_ID   default jinesis.lab@gmail.com
  GOG_BIN                         default ~/.local/bin/gog
  GOG_ACCOUNT                     default jinesis.adminbot@gmail.com
Args: --send  --venue-type {conference,workshop,all}  --within-days N  --limit N
"""

import argparse
import datetime
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VENUES = os.path.join(HERE, "..", "extensions", "adminbot", "deadlines", "venues.json")
CALENDAR_ID = os.environ.get("ADMINBOT_DEADLINE_CALENDAR_ID", "jinesis.lab@gmail.com")
GOG = os.environ.get("GOG_BIN", os.path.expanduser("~/.local/bin/gog"))
ACCOUNT = os.environ.get("GOG_ACCOUNT", "jinesis.adminbot@gmail.com")
MARKER = "adminbot-deadline"


def gog(args, check=True):
    result = subprocess.run(
        [GOG, *args, "--account", ACCOUNT, "--no-input"],
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        raise SystemExit(f"gog {' '.join(args[:2])} failed: {result.stderr.strip()[:300]}")
    return result


def aoe_date(deadline_aoe):
    """The calendar date the deadline falls on in AoE, which is the date people plan against."""
    stamp = datetime.datetime.strptime(deadline_aoe, "%Y-%m-%d %H:%M:%S")
    return stamp.date()


def marker_for(venue_id):
    return f"[{MARKER}:{venue_id}]"


def build_event(item):
    day = aoe_date(item["deadline_aoe"])
    summary = f"{item['name']} — {item.get('deadline_label') or 'deadline'}"
    lines = [
        f"{item['name']} ({item.get('venue_type', 'venue')})",
        f"Deadline: {item['deadline_aoe']} AoE",
    ]
    if item.get("notification_aoe"):
        lines.append(f"Notification: {item['notification_aoe']} AoE")
    if item.get("link"):
        lines.append(item["link"])
    lines += ["", "Maintained by AdminBot from venues.json. Edits here are overwritten.", marker_for(item["id"])]
    return {
        "summary": summary[:200],
        # All-day events are half-open in the Google API: end is the day after the deadline.
        "start": day.isoformat(),
        "end": (day + datetime.timedelta(days=1)).isoformat(),
        "description": "\n".join(lines),
    }


def existing_events(window_start, window_end):
    """Map marker -> eventId for AdminBot-managed events already on the calendar."""
    result = gog(
        [
            "calendar", "events", CALENDAR_ID,
            "--from", window_start.isoformat(),
            "--to", window_end.isoformat(),
            "--max", "2500", "--json",
        ],
        check=False,
    )
    if result.returncode != 0:
        print(f"warning: could not list existing events ({result.stderr.strip()[:160]});", file=sys.stderr)
        print("         running without dedupe would create duplicates, so stopping.", file=sys.stderr)
        raise SystemExit(1)
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        raise SystemExit("could not parse the event list as JSON")
    events = payload if isinstance(payload, list) else payload.get("events", payload.get("items", []))
    found = {}
    for event in events or []:
        description = str(event.get("description") or "")
        for token in description.split():
            if token.startswith(f"[{MARKER}:"):
                found[token.strip()] = event.get("id")
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true", help="actually write to the calendar")
    ap.add_argument("--venue-type", choices=["conference", "workshop", "all"], default="all")
    ap.add_argument("--within-days", type=int, default=400, help="skip deadlines further out than this")
    ap.add_argument("--limit", type=int, default=0, help="cap the number of events touched")
    args = ap.parse_args()

    items = json.load(open(VENUES))["items"]
    today = datetime.date.today()
    horizon = today + datetime.timedelta(days=args.within_days)

    planned = []
    for item in items:
        if not item.get("deadline_aoe"):
            continue
        if args.venue_type != "all" and item.get("venue_type") != args.venue_type:
            continue
        day = aoe_date(item["deadline_aoe"])
        if day < today or day > horizon:
            continue
        planned.append((item, build_event(item)))
    planned.sort(key=lambda pair: pair[1]["start"])
    if args.limit:
        planned = planned[: args.limit]

    print(f"calendar: {CALENDAR_ID}")
    print(f"venues with an upcoming deadline: {len(planned)} (within {args.within_days} days)")
    if not planned:
        return

    if not args.send:
        for item, event in planned:
            print(f"  would add  {event['start']}  {event['summary'][:70]}")
        print("\ndry-run: nothing written. Re-run with --send to publish.")
        return

    window_start = min(datetime.date.fromisoformat(e["start"]) for _, e in planned)
    window_end = max(datetime.date.fromisoformat(e["end"]) for _, e in planned)
    existing = existing_events(window_start, window_end)

    created = updated = 0
    for item, event in planned:
        marker = marker_for(item["id"])
        event_id = existing.get(marker)
        if event_id:
            gog([
                "calendar", "update", CALENDAR_ID, event_id,
                "--summary", event["summary"],
                "--description", event["description"],
                "--from", event["start"], "--to", event["end"], "--all-day",
            ])
            updated += 1
            print(f"  updated  {event['start']}  {event['summary'][:66]}")
        else:
            gog([
                "calendar", "create", CALENDAR_ID,
                "--summary", event["summary"],
                "--description", event["description"],
                "--from", event["start"], "--to", event["end"], "--all-day",
            ])
            created += 1
            print(f"  created  {event['start']}  {event['summary'][:66]}")

    print(f"\ncreated: {created} | updated: {updated} | calendar: {CALENDAR_ID}")


if __name__ == "__main__":
    main()
