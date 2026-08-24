#!/usr/bin/env python3
"""
AdminBot deadline digest (Output 1).

Posts a short "upcoming deadlines" summary to #jinesis-active. Schedule it
weekly via OpenClaw cron. Reads the same dataset as Outputs 0/2
(extensions/adminbot/content/deadlines/venues.json). Times are AoE (UTC-12).

Dry-run by default (prints the message). Use --send to post.

Env:
  ADMINBOT_ACTIVE_CHANNEL   Slack target for the digest (default "#jinesis-active")
  OPENCLAW_CLI              default ../openclaw.mjs
  ADMINBOT_DEADLINE_NOW     override "today" (YYYY-MM-DD), for testing
Args: --send   --days N (window, default 45)   --now YYYY-MM-DD
"""
import argparse
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adminbot_deadlines import AoEClock, DeadlineDataset, SlackNotifier, urgency_marker

CHANNEL = os.environ.get("ADMINBOT_ACTIVE_CHANNEL", "#jinesis-active")


def digest_line(venue, clock):
    """One venue's line: urgency, AoE calendar date, countdown, name, optional link."""
    days = clock.days_until(venue["deadline_aoe"])
    link = f"  <{venue['link']}|↗>" if venue.get("link") else ""
    return (
        f"{urgency_marker(days)} *{AoEClock.calendar_label(venue['deadline_aoe'])}* "
        f"({days}d) — {venue['name']}{link}"
    )


def build_message(venues, clock, window_days):
    """Render the digest, or None when nothing falls inside the window."""
    if not venues:
        return None

    # Workshops sharing a venue_group and a date collapse into one line: a call that
    # spawns ~100 co-located workshops would otherwise bury the handful of distinct
    # conference dates. Grouping is by dataset field, never by venue name, so a lone
    # workshop still shows under its own name and a new series needs no code change.
    grouped_workshops = defaultdict(list)
    entries = []
    for venue in venues:
        if venue["venue_type"] == "workshop":
            grouped_workshops[(venue["venue_group"], venue["deadline_aoe"])].append(venue)
        else:
            entries.append((venue["deadline_aoe"], venue["name"], digest_line(venue, clock)))
    for (group, _instant), members in grouped_workshops.items():
        first = members[0]
        if len(members) == 1:
            entries.append((first["deadline_aoe"], first["name"], digest_line(first, clock)))
            continue
        days = clock.days_until(first["deadline_aoe"])
        entries.append((
            first["deadline_aoe"],
            first["name"],
            f"{urgency_marker(days)} *{AoEClock.calendar_label(first['deadline_aoe'])}* "
            f"({days}d) — *{len(members)} {group}* (unified deadline)",
        ))
    # Same ordering DeadlineDataset.upcoming applies, re-established because collapsing
    # a group moves its line to the group's earliest deadline.
    entries.sort(key=lambda entry: (entry[0], entry[1]))

    lines = [f"📅 *Upcoming deadlines* — next {window_days} days (times AoE)"]
    lines += [text for _deadline, _name, text in entries]
    lines.append(
        "\nFull live countdown board + your paper's reminders are in the "
        "AdminBot Deadlines tab. — Jinesis Lab AdminBot 🦞"
    )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--send", action="store_true")
    parser.add_argument("--days", type=int, default=45)
    parser.add_argument("--now", default=None)
    args = parser.parse_args()

    clock = AoEClock.resolve(args.now)
    venues = DeadlineDataset().upcoming(clock, args.days)
    message = build_message(venues, clock, args.days)
    if not message:
        print(f"no deadlines within {args.days} days of {clock.today}; nothing to post")
        return

    notifier = SlackNotifier(send=args.send)
    if notifier.send(CHANNEL, message):
        print(f"posted digest to {CHANNEL}")


if __name__ == "__main__":
    main()
