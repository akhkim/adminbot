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
import json, os, subprocess, argparse, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DDIR = os.path.join(HERE, "..", "extensions", "adminbot", "deadlines")
CLI = os.environ.get("OPENCLAW_CLI", os.path.join(HERE, "..", "openclaw.mjs"))
CHANNEL = os.environ.get("ADMINBOT_ACTIVE_CHANNEL", "#jinesis-active")
MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def aoe_utc(aoe):
    d = datetime.datetime.strptime(aoe, "%Y-%m-%d %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    return d + datetime.timedelta(hours=12)


def urgency(days):
    return "🔴" if days <= 3 else "🟠" if days <= 7 else "🟡" if days <= 30 else "🟢"


def build_message(items, now, window_days):
    horizon = now + datetime.timedelta(days=window_days)
    up = []
    for it in items:
        D = aoe_utc(it["deadline_aoe"])
        if now <= D <= horizon:
            up.append((D, it))
    up.sort(key=lambda x: x[0])
    if not up:
        return None

    # collapse the 73 workshops into one line (they share Aug 29)
    ws = [x for x in up if x[1]["venue_type"] == "workshop"]
    other = [x for x in up if x[1]["venue_type"] != "workshop"]

    def aoe_label(it):                       # AoE calendar date (not the +12h UTC instant)
        y, m, d = it["deadline_aoe"][:10].split("-")
        return f"{MONTHS[int(m)]} {int(d)}"
    lines = [f"📅 *Upcoming deadlines* — next {window_days} days (times AoE)"]
    for D, it in other:
        days = (D - now).days
        lines.append(f"{urgency(days)} *{aoe_label(it)}* ({days}d) — {it['name']}"
                     + (f"  <{it['link']}|↗>" if it.get("link") else ""))
    if ws:
        D, it = ws[0]; days = (D - now).days
        lines.append(f"{urgency(days)} *{aoe_label(it)}* ({days}d) — "
                     f"*{len(ws)} NeurIPS 2026 workshops* (unified deadline)")
    lines.append("\nFull live countdown board + your paper's reminders are in the "
                 "AdminBot Deadlines tab. — Jinesis Lab AdminBot 🦞")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true")
    ap.add_argument("--days", type=int, default=45)
    ap.add_argument("--now", default=os.environ.get("ADMINBOT_DEADLINE_NOW",
                                                    datetime.date.today().isoformat()))
    a = ap.parse_args()
    d = datetime.date.fromisoformat(a.now)
    now = datetime.datetime(d.year, d.month, d.day, 12, tzinfo=datetime.timezone.utc)

    items = json.load(open(os.path.join(DDIR, "venues.json")))["items"]
    msg = build_message(items, now, a.days)
    if not msg:
        print(f"no deadlines within {a.days} days of {a.now}; nothing to post")
        return

    if not a.send:
        print(f"[dry-run] would post to {CHANNEL}:\n" + "-" * 60 + f"\n{msg}\n" + "-" * 60)
        return
    subprocess.run(["node", CLI, "message", "send", "--channel", "slack",
                    "--target", CHANNEL, "--message", msg, "--json"], check=False)
    print(f"posted digest to {CHANNEL}")


if __name__ == "__main__":
    main()
