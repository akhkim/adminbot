#!/usr/bin/env python3
"""
AdminBot deadline reminders (Output 2, runner). Mirror of
scripts/adminbot-paper-nudge-reminders.mjs, for submission deadlines.

Each run (schedule it ~daily via OpenClaw cron):
  1. Load venues.json, matches.json, dm-templates.json.
  2. For every matched paper on live cadence, compute its 30/15/7/3/2/1-day
     reminder dates from the deadline and fire the one that is DUE today.
  3. Stop-condition: if the paper already shows in Zhijing's OpenReview
     submissions (auth required) OR an author replied "done", do not remind.
  4. Escalate to Zhijing for any paper past its deadline still unsubmitted.

DELIVERY is dry-run by default. Nothing is sent unless --send is passed AND a
Slack target resolves.  Author -> Slack id comes from the AdminBot roster
(GET {ADMINBOT_SERVICE_BASE_URL}/lab/members -> slack_user_id).

Env:
  ADMINBOT_SERVICE_BASE_URL   default http://127.0.0.1:8765
  OPENCLAW_CLI                default ../openclaw.mjs        (message send)
  OPENREVIEW_USERNAME / OPENREVIEW_PASSWORD   (Zhijing enters these herself;
                                               absent -> stop-check skipped)
  ADMINBOT_HEAD_PROFESSOR_SLACK   Zhijing's slack id for escalations
  ADMINBOT_DEADLINE_NOW           override "today" (YYYY-MM-DD), for testing
Args: --send   --now YYYY-MM-DD
"""
import argparse
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adminbot_deadlines import AoEClock, DeadlineDataset, SlackNotifier

CADENCE = [30, 15, 7, 3, 2, 1]
SVC = os.environ.get("ADMINBOT_SERVICE_BASE_URL", "http://127.0.0.1:8765")

ACTION_KEY = {   # venue_group -> template action key
    "EMNLP 2026": "emnlp_commitment", "NeurIPS 2026": "neurips_rebuttal",
    "ARR August 2026": "arr_august", "ICLR 2027": "iclr2027",
    "NAACL 2027": "naacl2027"}
DEFAULT_ACTION_KEY = "emnlp_commitment"
# Every co-located workshop call reads the same way, so one venue-agnostic template
# serves them all; a new "<venue> Workshops" group needs a dataset row, not a code edit.
WORKSHOP_GROUP_SUFFIX = " Workshops"
WORKSHOP_ACTION_KEY = "workshop"


def norm(value):
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


# ---- roster: author name -> slack id (best-effort; dry-run works without) ----
def load_roster():
    try:
        req = urllib.request.Request(SVC.rstrip("/") + "/lab/members",
                                     headers={"User-Agent": "jinesis-adminbot/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            members = json.load(r).get("members", [])
    except Exception as e:
        print(f"WARN: roster unavailable ({e}); Slack ids unresolved (dry-run only)", file=sys.stderr)
        return {}
    idx = {}
    for m in members:
        sid = m.get("slack_user_id")
        if not sid:
            continue
        first = (m.get("name") or "").split()[0].lower()
        idx[(m.get("name") or "").lower()] = sid
        if first:
            idx.setdefault(first, sid)
    return idx


def resolve_slack(author, roster):
    key = author.strip().lower()
    return roster.get(key) or roster.get(key.split()[0] if key else "")


# ---- OpenReview stop-condition (auth required; graceful fallback) ----
def openreview_submitted_titles():
    u, p = os.environ.get("OPENREVIEW_USERNAME"), os.environ.get("OPENREVIEW_PASSWORD")
    if not (u and p):
        return None                            # unknown -> never blocks, escalate at deadline
    try:
        body = json.dumps({"id": u, "password": p}).encode()
        req = urllib.request.Request("https://api2.openreview.net/login", data=body,
                                     headers={"Content-Type": "application/json"})
        tok = json.load(urllib.request.urlopen(req, timeout=30)).get("token")
        url = "https://api2.openreview.net/notes?content.authorids=~Zhijing_Jin1&limit=1000"
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
        notes = json.load(urllib.request.urlopen(req, timeout=45)).get("notes", [])
        out = set()
        for n in notes:
            c = n.get("content", {})
            t = c.get("title", {})
            t = t.get("value") if isinstance(t, dict) else t
            if t:
                out.add(norm(t))
        return out
    except Exception as e:
        print(f"WARN: OpenReview check failed ({e}); stop-check skipped this run", file=sys.stderr)
        return None


def action_key_for(paper):
    venue_group = paper.get("venue_group") or ""
    if venue_group.endswith(WORKSHOP_GROUP_SUFFIX):
        return WORKSHOP_ACTION_KEY
    return ACTION_KEY.get(venue_group, DEFAULT_ACTION_KEY)


def render(step, paper, tmpl, workshop=None):
    act = tmpl["actions"][action_key_for(paper)]
    # The workshop template carries a {workshop} slot. An ongoing workshop paper names
    # no specific workshop, so fall back to its venue group: the DM must never ship a
    # literal "{workshop}" token to an author.
    workshop_name = workshop or paper.get("venue_group") or "your target workshop"
    action = act["action"].replace("{workshop}", workshop_name).replace("{paper}", paper["title"])
    deadline_date = AoEClock.calendar_date(paper["deadline_aoe"])
    return tmpl["steps"][str(step)].format(
        paper=paper["title"], noun=act["noun"],
        date=deadline_date.strftime("%b %d, %Y") + " AoE",
        action=action, link=paper.get("overleaf", "(no Overleaf link on file)"),
    ) + tmpl["footer"]


def confirmed_papers(matches):
    """Only confirmed items get nudged.

    `ongoing` rows are auto-confirmed by the matcher; workshop suggestions in
    `ready` stay unconfirmed until a human sets confirmed=true, so a fuzzy topic
    match can never DM an author on its own.
    """
    papers = [p for p in matches.get("ongoing", []) if p.get("confirmed")]
    papers += [p for p in matches.get("ready", []) if p.get("confirmed")]
    return papers


def due_cadence_step(paper, clock):
    """The cadence step firing today, or None. Cadence is ordered widest-first."""
    for step in CADENCE:
        if clock.is_cadence_day(paper["deadline_aoe"], step):
            return step
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--send", action="store_true")
    parser.add_argument("--now", default=None)
    args = parser.parse_args()

    clock = AoEClock.resolve(args.now)
    dataset = DeadlineDataset()
    tmpl = dataset.templates()
    notifier = SlackNotifier(send=args.send)

    roster = load_roster()
    submitted = openreview_submitted_titles()

    fired, escalations = 0, []
    for paper in confirmed_papers(dataset.matches()):
        if submitted is not None and norm(paper["title"]) in submitted:
            continue                           # already submitted -> silent
        if clock.has_passed(paper["deadline_aoe"]):
            escalations.append(paper)
            continue
        step = due_cadence_step(paper, clock)
        if step is None:
            continue
        workshop = paper["suggestions"][0]["name"] if paper.get("suggestions") else None
        text = render(step, paper, tmpl, workshop=workshop)
        print(f"  T-{step}d  {paper['title'][:56]}  ({paper.get('venue_group')})")
        for author in paper.get("authors", []):
            slack_id = resolve_slack(author, roster)
            if slack_id:
                notifier.send_to_user(slack_id, text)
                fired += 1
            else:
                print(f"    [skip] no Slack id for author '{author}'")

    if escalations:
        prof_slack = os.environ.get("ADMINBOT_HEAD_PROFESSOR_SLACK")
        listing = "\n".join(
            f"• *{p['title']}* ({p.get('venue_group')}, "
            f"{AoEClock.calendar_date(p['deadline_aoe'])}) — "
            f"authors: {', '.join(p.get('authors', []))}"
            for p in escalations
        )
        message = tmpl["escalation"].format(prof="Zhijing", list=listing)
        print(f"\n  ESCALATION ({len(escalations)} unsubmitted past deadline):")
        if prof_slack:
            notifier.send_to_user(prof_slack, message)
        else:
            print("    [dry-run] (set ADMINBOT_HEAD_PROFESSOR_SLACK to deliver)\n    "
                  + message.replace("\n", "\n    "))

    print(f"\nreminders fired: {fired} | escalations: {len(escalations)} | "
          f"mode: {notifier.mode} | now={clock.today} | "
          f"openreview-stop: {'on' if submitted is not None else 'off (no creds)'}")


if __name__ == "__main__":
    main()
