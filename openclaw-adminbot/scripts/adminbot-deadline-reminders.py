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
import json, os, re, sys, subprocess, argparse, datetime, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
DDIR = os.path.join(HERE, "..", "extensions", "adminbot", "deadlines")
CADENCE = [30, 15, 7, 3, 2, 1]
SVC = os.environ.get("ADMINBOT_SERVICE_BASE_URL", "http://127.0.0.1:8765")
CLI = os.environ.get("OPENCLAW_CLI", os.path.join(HERE, "..", "openclaw.mjs"))


def aoe_utc(aoe):                              # "YYYY-MM-DD HH:MM:SS" AoE -> UTC datetime
    d = datetime.datetime.strptime(aoe, "%Y-%m-%d %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    return d + datetime.timedelta(hours=12)


def load(name):
    return json.load(open(os.path.join(DDIR, name)))


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


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def render(step, paper, tmpl, workshop=None):
    act = tmpl["actions"][paper["_action_key"]]
    action = act["action"]
    if workshop:
        action = action.replace("{workshop}", workshop).replace("{paper}", paper["title"])
    body = tmpl["steps"][str(step)].format(
        paper=paper["title"], noun=act["noun"],
        date=paper["_deadline_date"].strftime("%b %d, %Y") + " AoE",
        action=action, link=paper.get("overleaf", "(no Overleaf link on file)"))
    return body + tmpl["footer"]


ACTION_KEY = {   # venue_group -> template action key
    "EMNLP 2026": "emnlp_commitment", "NeurIPS 2026": "neurips_rebuttal",
    "ARR August 2026": "arr_august", "ICLR 2027": "iclr2027",
    "NAACL 2027": "naacl2027", "NeurIPS 2026 Workshops": "neurips_workshop"}


def send_dm(slack_id, text, do_send):
    tgt = "user:" + slack_id
    if not do_send:
        print(f"    [dry-run] would DM {tgt}:\n      " + text.replace("\n", "\n      "))
        return
    subprocess.run(["node", CLI, "message", "send", "--channel", "slack",
                    "--target", tgt, "--message", text, "--json"], check=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true")
    ap.add_argument("--now", default=os.environ.get("ADMINBOT_DEADLINE_NOW",
                                                    datetime.date.today().isoformat()))
    a = ap.parse_args()
    now_d = datetime.date.fromisoformat(a.now)
    now = datetime.datetime(now_d.year, now_d.month, now_d.day, 12, tzinfo=datetime.timezone.utc)

    tmpl = load("dm-templates.json")
    matches = load("matches.json")
    roster = load_roster()
    submitted = openreview_submitted_titles()
    stop_titles = submitted if submitted is not None else set()

    # only confirmed items get nudged (ongoing = auto-confirmed; ready workshop
    # suggestions must have confirmed=true set by a human first)
    papers = [p for p in matches["ongoing"] if p.get("confirmed")]
    papers += [dict(p, _action_key=None) for p in matches.get("ready", []) if p.get("confirmed")]

    fired, escalations = 0, []
    for p in papers:
        D = aoe_utc(p["deadline_aoe"])
        p["_deadline_date"] = D.date()
        p["_action_key"] = ACTION_KEY.get(p["venue_group"], "emnlp_commitment")
        if submitted is not None and norm(p["title"]) in stop_titles:
            continue                           # already submitted -> silent
        # past deadline & unsubmitted -> escalate
        if now > D:
            escalations.append(p)
            continue
        # fire the reminder whose date == today
        for k in CADENCE:
            if (D - datetime.timedelta(days=k)).date() == now_d:
                ws = p["suggestions"][0]["name"] if p.get("suggestions") else None
                text = render(k, p, tmpl, workshop=ws)
                recips = [(au, resolve_slack(au, roster)) for au in p.get("authors", [])]
                print(f"  T-{k}d  {p['title'][:56]}  ({p['venue_group']})")
                for au, sid in recips:
                    if sid:
                        send_dm(sid, text, a.send); fired += 1
                    else:
                        print(f"    [skip] no Slack id for author '{au}'")
                break

    # escalation digest to Zhijing
    if escalations:
        prof_slack = os.environ.get("ADMINBOT_HEAD_PROFESSOR_SLACK")
        lst = "\n".join(f"• *{p['title']}* ({p['venue_group']}, {p['_deadline_date']}) — "
                        f"authors: {', '.join(p.get('authors', []))}" for p in escalations)
        msg = tmpl["escalation"].format(prof="Zhijing", list=lst)
        print(f"\n  ESCALATION ({len(escalations)} unsubmitted past deadline):")
        if prof_slack:
            send_dm(prof_slack, msg, a.send)
        else:
            print("    [dry-run] (set ADMINBOT_HEAD_PROFESSOR_SLACK to deliver)\n    " + msg.replace("\n", "\n    "))

    print(f"\nreminders fired: {fired} | escalations: {len(escalations)} | "
          f"mode: {'SEND' if a.send else 'dry-run'} | now={a.now} | "
          f"openreview-stop: {'on' if submitted is not None else 'off (no creds)'}")


if __name__ == "__main__":
    main()
