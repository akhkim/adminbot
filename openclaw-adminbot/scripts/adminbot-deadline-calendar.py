#!/usr/bin/env python3
"""
Publish tracked submission deadlines to the Jinesis Lab Google Calendar.

Reads the same `venues.json` the deadline board and reminders use, and writes one final-hour event
per venue deadline to the lab calendar named by `ADMINBOT_DEADLINE_CALENDAR_ID`.

Two things make this safe to run repeatedly:

  * Every event carries a marker line in its description, `[adminbot-deadline:<venue id>]`. A run
    searches the calendar for that marker before creating anything, so re-running updates the
    existing event instead of stacking duplicates. The venue id is the key, not the title, so a
    renamed venue moves its own event rather than orphaning one.
  * Nothing is written without `--send`. The default prints the plan, matching every other script
    in the deadline set.

Deadlines are AoE (UTC-12). Events span the hour before the actual cutoff, displayed in each
viewer's local timezone; the description preserves the original AoE date and time.

Env:
  ADMINBOT_DEADLINE_CALENDAR_ID   required; falls back to ADMINBOT_LAB_EMAIL
  GOG_BIN                         default ~/.local/bin/gog
  GOG_ACCOUNT                     required; falls back to ADMINBOT_BOT_EMAIL
Args: --send  --venue-type {conference,workshop,all}  --within-days N  --limit N
"""

import argparse
import datetime
import json
import os
import subprocess
import sys

from adminbot_deadlines import AoEClock, DeadlineDataset

HERE = os.path.dirname(os.path.abspath(__file__))
VENUES = os.path.join(HERE, "..", "extensions", "adminbot", "content", "deadlines", "venues.json")


def _require_env(*names):
    """First non-empty of `names`, or a clear exit naming the first one.

    The calendar and the sending account name a real Google Workspace, so there is deliberately no
    default: a baked-in address would write lab deadlines into a stranger's calendar.
    """
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    sys.exit(
        f"{names[0]} is not set - the deadline calendar job has no "
        + ("calendar to write to" if "CALENDAR" in names[0] else "account to send as")
    )


CALENDAR_ID = _require_env("ADMINBOT_DEADLINE_CALENDAR_ID", "ADMINBOT_LAB_EMAIL")
GOG = os.environ.get("GOG_BIN", os.path.expanduser("~/.local/bin/gog"))
ACCOUNT = _require_env("GOG_ACCOUNT", "ADMINBOT_BOT_EMAIL")
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
    end = AoEClock.instant(item["deadline_aoe"])
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
        "start": (end - datetime.timedelta(hours=1)).isoformat(),
        "end": end.isoformat(),
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

    items = DeadlineDataset(os.path.dirname(VENUES)).venues()
    now = AoEClock.resolve().now
    horizon = now + datetime.timedelta(days=args.within_days)

    planned = []
    for item in items:
        if not item.get("deadline_aoe"):
            continue
        if args.venue_type != "all" and item.get("venue_type") != args.venue_type:
            continue
        deadline = AoEClock.instant(item["deadline_aoe"])
        if deadline < now or deadline > horizon:
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
            print(f"  would sync  {event['start']} → {event['end']}  {event['summary'][:70]}")
        print("\ndry-run: nothing written. Re-run with --send to publish.")
        return

    # Include old all-day entries and new timed entries, with padding for calendar timezones.
    window_start = min(aoe_date(item["deadline_aoe"]) for item, _ in planned) - datetime.timedelta(days=1)
    window_end = max(datetime.datetime.fromisoformat(e["end"]).date() for _, e in planned) + datetime.timedelta(days=2)
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
                "--from", event["start"], "--to", event["end"], "--all-day=false",
            ])
            updated += 1
            print(f"  updated  {event['start']}  {event['summary'][:66]}")
        else:
            gog([
                "calendar", "create", CALENDAR_ID,
                "--summary", event["summary"],
                "--description", event["description"],
                "--from", event["start"], "--to", event["end"], "--all-day=false",
            ])
            created += 1
            print(f"  created  {event['start']}  {event['summary'][:66]}")

    print(f"\ncreated: {created} | updated: {updated} | calendar: {CALENDAR_ID}")


if __name__ == "__main__":
    main()
