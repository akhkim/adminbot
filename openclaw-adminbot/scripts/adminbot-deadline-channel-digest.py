#!/usr/bin/env python3
"""
AdminBot deadline digest (Output 1).

Posts a short "upcoming deadlines" summary to #jinesis-active. Schedule it
weekly via OpenClaw cron. Reads the same dataset as Outputs 0/2
(extensions/adminbot/deadlines/venues.json). Times are AoE (UTC-12).

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adminbot_deadlines import AoEClock, DeadlineDataset, SlackNotifier, urgency_marker

CHANNEL = os.environ.get("ADMINBOT_ACTIVE_CHANNEL", "#jinesis-active")


def build_message(venues, clock, window_days):
    """Render the digest, or None when nothing falls inside the window."""
    if not venues:
        return None

    # The NeurIPS workshops share one unified deadline, so listing all ~100
    # would bury the handful of distinct conference dates that need attention.
    workshops = [v for v in venues if v["venue_type"] == "workshop"]
    others = [v for v in venues if v["venue_type"] != "workshop"]

    lines = [f"📅 *Upcoming deadlines* — next {window_days} days (times AoE)"]
    for venue in others:
        days = clock.days_until(venue["deadline_aoe"])
        link = f"  <{venue['link']}|↗>" if venue.get("link") else ""
        lines.append(
            f"{urgency_marker(days)} *{AoEClock.calendar_label(venue['deadline_aoe'])}* "
            f"({days}d) — {venue['name']}{link}"
        )
    if workshops:
        first = workshops[0]
        days = clock.days_until(first["deadline_aoe"])
        lines.append(
            f"{urgency_marker(days)} *{AoEClock.calendar_label(first['deadline_aoe'])}* "
            f"({days}d) — *{len(workshops)} NeurIPS 2026 workshops* (unified deadline)"
        )
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
