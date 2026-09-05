#!/usr/bin/env python3
"""
AdminBot opportunity discovery sweep.

Reads the hub pages named in config/adminbot-opportunity-sources.json, follows the links on them,
and files what looks like a programme as a *pending* opportunity for an admin to publish or throw
away. It never publishes: the board is served to signed-out visitors, and a sweep has no judgement
about whether a programme is one this lab cares about.

What it is not. This does not search the web -- it reads hubs somebody chose. That is the whole
difference between a feed you can audit and a pile of plausible links: every candidate names the
page it came from and the line its date was read out of, and an admin's Approve is what puts it in
front of members.

The rule that keeps the queue readable is in the service, not here: a source already on the board
is not filed again, and a source an admin rejected stays rejected. Rejected rows are the
suppression list. So this can run every week without asking twice about the same programme.

Run:
  python3 scripts/adminbot-opportunity-discover.py            # dry run, prints what it found
  python3 scripts/adminbot-opportunity-discover.py --apply    # files the candidates

Reads ADMINBOT_URL (default http://127.0.0.1:8765) and ADMINBOT_SERVICE_TOKEN.
"""
import argparse
import datetime
import html as html_module
import json
import os
import re
import sys
import urllib.error
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from adminbot_opportunities import (  # noqa: E402
    NOT_THE_APPLICANTS_DATE,
    OPPORTUNITY_SIGNALS,
    fetch_html,
)
from adminbot_workshop_deadlines import (  # noqa: E402
    deadline_candidates_from_html,
    select_official_candidate,
)

SOURCES = os.path.join(HERE, "..", "config", "adminbot-opportunity-sources.json")

# How many links one hub may contribute in a run. A review queue with forty rows in it is one
# nobody opens, and a hub that lists two hundred links is a hub, not a shortlist.
PER_SOURCE_LIMIT = 8

LINK = re.compile(r"""<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>""", re.I | re.S)
TAGS = re.compile(r"<[^>]+>")

# A link is a candidate when its own text reads like a programme. Weak on purpose: the page it
# points at has to yield an application date before anything is filed, which is the real filter.
PROGRAMME = re.compile(
    r"(?i)\b(fellowship|scholarship|internship|programme|program|award|grant|rising stars"
    r"|residency|traineeship|cohort)\b"
)


def link_text(raw):
    return html_module.unescape(TAGS.sub(" ", raw)).strip()


def candidate_links(page_html, page_url, pattern):
    """Absolute links on a hub whose text reads like a programme, in page order, deduplicated."""
    seen = set()
    out = []
    for href, raw in LINK.findall(page_html):
        text = link_text(raw)
        if not text or len(text) > 200 or not PROGRAMME.search(text):
            continue
        url = urllib.parse.urljoin(page_url, href.strip())
        if not url.startswith("https://") or url in seen:
            continue
        if pattern and not pattern.search(url):
            continue
        seen.add(url)
        out.append((url, text))
    return out


def application_date(url, year):
    """The date this page states for applicants, or None. Same rule as the refresh sweep."""
    try:
        resolved, page = fetch_html(url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return None, None
    candidates, _assets = deadline_candidates_from_html(page, resolved, year, OPPORTUNITY_SIGNALS)
    candidates = [
        candidate
        for candidate in candidates
        if not NOT_THE_APPLICANTS_DATE.search(candidate["context"])
    ]
    # The year has to be on the page, next to the date.
    #
    # A bare "July 1st" gets the sweep's year imputed, and these hubs are full of pages nobody has
    # touched since an old cycle: CRA's CSGrad4US page says "Application Deadline: June 30, 2022"
    # and, further down, "Coach Applications received by July 1st" -- which came back as a
    # confident 2026-07-01. On a page somebody is re-reading that is a bad guess; in a queue of
    # things nobody asked for it is a fabrication.
    candidates = [
        candidate for candidate in candidates if str(year) in candidate["context"]
    ]
    if not candidates:
        return None, resolved
    # One date or none, for the reason the refresh sweep gives: choosing between several needs
    # knowledge this has none of, and a plausible wrong date is worse than no candidate.
    if len({candidate["stamp"][:10] for candidate in candidates}) > 1:
        return None, resolved
    selected, _ranked = select_official_candidate(candidates, "", year)
    return selected or max(candidates, key=lambda candidate: candidate["score"]), resolved


def service_request(base, path, token, payload=None):
    from adminbot_opportunities import HTTP_HEADERS
    import urllib.request

    request = urllib.request.Request(
        f"{base.rstrip('/')}{path}",
        headers={**HTTP_HEADERS, "Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="file the candidates (default: dry run)")
    parser.add_argument("--base", default=os.environ.get("ADMINBOT_URL", "http://127.0.0.1:8765"))
    parser.add_argument("--year", type=int, default=datetime.date.today().year)
    args = parser.parse_args()

    token = os.environ.get("ADMINBOT_SERVICE_TOKEN", "").strip()
    if not token:
        raise SystemExit("ADMINBOT_SERVICE_TOKEN is not set")

    with open(SOURCES, encoding="utf-8") as handle:
        sources = json.load(handle).get("sources") or []
    if not sources:
        print("no hub pages configured — add them to config/adminbot-opportunity-sources.json")
        return

    filed = looked = 0
    for source in sources:
        name = source.get("name") or source.get("url")
        pattern = re.compile(source["link_pattern"]) if source.get("link_pattern") else None
        try:
            resolved, page = fetch_html(source["url"])
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as error:
            print(f"  ! {name}: could not read the hub: {error}")
            continue
        links = candidate_links(page, resolved, pattern)[:PER_SOURCE_LIMIT]
        print(f"  {name}: {len(links)} link(s) worth opening")
        for url, text in links:
            looked += 1
            selected, resolved_url = application_date(url, args.year)
            if not selected:
                continue
            print(f"    + {text[:70]} — {selected['stamp']}")
            print(f"      {resolved_url}")
            if args.apply:
                result = service_request(
                    args.base,
                    "/opportunities/discovered",
                    token,
                    {
                        "name": text[:200],
                        "category": source.get("category", "grants_awards"),
                        "link": resolved_url,
                        "deadline_aoe": selected["stamp"],
                        "discovered": {
                            "feed": "web",
                            "source_url": resolved_url,
                            "evidence": selected["evidence"],
                        },
                    },
                )
                filed += 1 if result.get("filed") else 0
    verb = "filed" if args.apply else "would file"
    print(f"opened {looked} page(s), {verb} {filed if args.apply else '?'}")


if __name__ == "__main__":
    try:
        main()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as error:
        raise SystemExit(f"opportunity discovery: could not reach the AdminBot service: {error}")
