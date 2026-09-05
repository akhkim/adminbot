#!/usr/bin/env python3
"""
AdminBot opportunity refresh sweep.

Re-reads the page behind each Opportunities entry and files what it finds as a *proposal* for a
human to accept. It never writes a date onto the board.

Why a proposal and not an update. These are annual programs -- PhD cycles, internships, Rising
Stars -- whose hosts edit one page in place each year. A page still carrying last year's date is
indistinguishable from one carrying next year's until somebody looks, and the board's own rule is
that an unannounced deadline must never render as though it were real, because members plan
around this tab. So the sweep says what it read and where it read it; a person says whether that
is this cycle's date.

Why it can only do this much. The deadline collector next door genuinely collects 143 workshops,
because OpenReview is a structured source with a stable schema. Opportunities have no such source:
every entry is a bespoke institutional page, and for the rotating programs even the host changes
each year. What is automatable here is the *revisit*, not the discovery -- so this sweeps the
entries that already exist and proposes nothing new.

Run:
  python3 scripts/adminbot-opportunity-refresh.py                  # dry run, prints what it found
  python3 scripts/adminbot-opportunity-refresh.py --apply          # files the proposals

Reads ADMINBOT_URL (default http://127.0.0.1:8765) and ADMINBOT_SERVICE_TOKEN.
"""
import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from adminbot_workshop_deadlines import (  # noqa: E402
    deadline_candidates_from_html,
    select_official_candidate,
)

# The same agent string the deadline collector introduces itself with. A sweep that reads a
# university's page should say who it is; several of these hosts block a bare urllib default.
HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36 AdminBot/1.0 (+https://admin.safe.eu)"
    ),
    "Accept-Language": "en",
}

# The phrases that mark a date an applicant is bound by.
#
# Passed in rather than added to the shared list: that one is tuned for papers ("submission
# deadline", "papers are due") across 143 workshops, and finds nothing at all on a fellowship page
# -- verified, it returns zero candidates. Adding application words there would let a CFP page that
# mentions an application deadline outrank its own paper deadline.
OPPORTUNITY_SIGNALS = (
    (re.compile(r"(?i)\bapplication\s+deadline\b"), 260),
    # Real pages say this at least as often as "application deadline" -- NSF GRFP heads its table
    # with it, and against the first vocabulary this sweep read that page and found nothing.
    (re.compile(r"(?i)\bapplicant\s+deadlines?\b"), 255),
    (re.compile(r"(?i)\bapplications?\s+(?:are\s+)?(?:now\s+)?due\b"), 250),
    (re.compile(r"(?i)\bdeadline\s+to\s+apply\b"), 245),
    (re.compile(r"(?i)\bnomination\s+deadline\b"), 240),
    (re.compile(r"(?i)\bapplications?\s+close[sd]?\b"), 235),
    (re.compile(r"(?i)\bapply\s+by\b"), 220),
    (re.compile(r"(?i)\bclosing\s+date\b"), 210),
)

# Rows that are dated on the same page but are not the applicant's own deadline. NSF GRFP heads
# its table with "Applicant deadlines" and then lists the reference-letter date first, so without
# this the highest-scoring candidate on that page is a date the applicant is not bound by.
NOT_THE_APPLICANTS_DATE = re.compile(
    r"(?i)reference\s+letters?|notification|results?\s+(?:are\s+)?announced|awards?\s+announced"
)

def fetch_html(url, timeout=20):
    request = urllib.request.Request(
        url,
        headers={**HTTP_HEADERS, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(2_000_000)
        charset = response.headers.get_content_charset() or "utf-8"
        return response.geturl(), body.decode(charset, errors="replace")


def service_request(base, path, token, payload=None):
    request = urllib.request.Request(
        f"{base.rstrip('/')}{path}",
        headers={
            # The agent string matters even talking to our own service: pointed at the public
            # origin this goes through Cloudflare, which answers a bare Python-urllib/3.x with a
            # 403 that looks exactly like an auth failure. On Aurora it is loopback and moot.
            **HTTP_HEADERS,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def candidate_for(entry, year):
    """
    The one date this page states for applicants, or a reason there is nothing to propose.

    Deliberately all-or-nothing. A page that offers several application dates -- NSF GRFP lists
    five, one per field of study -- is one where choosing needs knowledge the sweep does not have,
    and the board is planned against. Proposing the highest-scoring of five would put a plausible
    wrong date one click from being published, so the sweep reports the ambiguity and proposes
    nothing. The operator opens the page, which is what they would have done anyway, and the sweep
    has still done the useful half: it noticed.
    """
    url = (entry.get("link") or "").strip()
    if not url.startswith("https://"):
        return None, "no https link to read"
    try:
        resolved, html = fetch_html(url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as error:
        return None, f"could not read the page: {error}"
    candidates, _assets = deadline_candidates_from_html(
        html, resolved, year, OPPORTUNITY_SIGNALS
    )
    candidates = [
        candidate
        for candidate in candidates
        if not NOT_THE_APPLICANTS_DATE.search(candidate["context"])
    ]
    if not candidates:
        return None, "no application date on the page"
    distinct = sorted({candidate["stamp"][:10] for candidate in candidates})
    if len(distinct) > 1:
        return None, f"{len(distinct)} application dates on the page ({', '.join(distinct)}) — read it yourself"
    # One date, so the ranking is only choosing which mention of it to quote. No target hint: that
    # parameter exists to tell a CFP's abstract deadline from its paper deadline, and there is no
    # equivalent distinction here.
    selected, _ranked = select_official_candidate(candidates, entry.get("deadline_aoe") or "", year)
    if not selected:
        selected = max(candidates, key=lambda candidate: candidate["score"])
    return selected, ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="file the proposals (default: dry run)")
    parser.add_argument("--base", default=os.environ.get("ADMINBOT_URL", "http://127.0.0.1:8765"))
    parser.add_argument("--year", type=int, default=datetime.date.today().year)
    args = parser.parse_args()

    token = os.environ.get("ADMINBOT_SERVICE_TOKEN", "").strip()
    if not token:
        raise SystemExit("ADMINBOT_SERVICE_TOKEN is not set")

    board = service_request(args.base, "/opportunities", token)
    entries = board.get("opportunities") or []
    # Only what is on the board. A pending submission has not been accepted as a thing the lab
    # tracks yet, and proposing a date for it would be answering a question nobody has asked.
    live = [e for e in entries if e.get("status") == "approved" and (e.get("link") or "").strip()]
    print(f"{len(entries)} entries on the board, {len(live)} approved with a page to read")

    filed = skipped = unchanged = 0
    for entry in live:
        selected, why = candidate_for(entry, args.year)
        name = entry.get("name", entry.get("id", "?"))
        if not selected:
            print(f"  - {name}: {why}")
            skipped += 1
            continue
        stamp = selected["stamp"]
        if stamp == (entry.get("deadline_aoe") or ""):
            unchanged += 1
            continue
        print(f"  ~ {name}: {entry.get('deadline_aoe') or 'TBA'} -> {stamp}")
        print(f"      {selected['evidence'][:160]}")
        print(f"      {selected['source_url']}")
        if args.apply:
            result = service_request(
                args.base,
                f"/opportunities/{entry['id']}/deadline-proposal",
                token,
                {
                    "deadline_aoe": stamp,
                    "source_url": selected["source_url"],
                    "evidence": selected["evidence"],
                },
            )
            filed += 1 if result.get("filed") else 0
    verb = "filed" if args.apply else "would file"
    print(f"{unchanged} unchanged, {skipped} unreadable, {verb} {filed if args.apply else '?'}")


if __name__ == "__main__":
    try:
        main()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as error:
        # stdout is the run summary in the Cron tab and a traceback is not one. The service being
        # down or refusing the token is the ordinary failure here, and it should read as a
        # sentence and turn the run red.
        raise SystemExit(f"opportunity refresh: could not reach the AdminBot service: {error}")
