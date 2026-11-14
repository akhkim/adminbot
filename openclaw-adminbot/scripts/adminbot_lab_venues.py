"""Deadlines for the venues the lab actually publishes at, derived from its paper records.

CONFERENCES in the collector is a hand-kept list, so a venue stays on the board only as long as
somebody remembers to add next year's round. The paper records already say where the lab submits:
every family that appears there gets its upcoming round looked up on OpenReview, and a family
with no known portal is reported rather than silently missing.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request

from adminbot_deadlines import ALL_FAMILIES, ARR_FAMILIES, is_sweep_due

# OpenReview conference group per family. Each prefix was read from a round that exists; a wrong
# one is silent, because a group with no invitation looks exactly like a round that has not opened.
LAB_VENUE_GROUPS = {
    "NeurIPS": "NeurIPS.cc/{year}/Conference",
    "ICML": "ICML.cc/{year}/Conference",
    "ICLR": "ICLR.cc/{year}/Conference",
    "COLM": "colmweb.org/COLM/{year}/Conference",
    "EMNLP": "EMNLP/{year}/Conference",
    "AISTATS": "aistats.org/AISTATS/{year}/Conference",
    "CLeaR": "cclear.cc/CLeaR/{year}/Conference",
    "AAAI": "AAAI.org/{year}/Conference",
    "UAI": "auai.org/UAI/{year}/Conference",
    "IASEAI": "IASEAI.org/{year}/Conference",
}

# This edition and the next: a conference held next year usually closes submissions this year.
LAB_VENUE_YEAR_SPAN = 2
AUTO_ID_PREFIX = "auto_"

_KNOWN_FAMILIES = tuple(dict.fromkeys(ALL_FAMILIES + tuple(LAB_VENUE_GROUPS)))


def paper_family(venue: str) -> str:
    """The family a paper's free-text venue names, or "" when it is not one with a known source.

    Whole-token match, longest first, so NAACL is never read as ACL and "UAI" is not found inside
    another word. Hyphenated names such as AACL-IJCNLP match on their first part.
    """
    tokens = {token.upper() for token in re.findall(r"[A-Za-z]+", venue or "")}
    for family in sorted(_KNOWN_FAMILIES, key=len, reverse=True):
        if family.upper() in tokens:
            return family
    return ""


def lab_venue_counts(papers):
    """(papers per known family, papers per unrecognized venue string), from every paper record.

    Accepted and rejected papers count too: a past submission is the evidence that the lab cares
    about the venue, which is a different question from which papers are still in flight.
    """
    families, unknown = {}, {}
    for paper in papers or []:
        venue = str(paper.get("venue") or "").strip()
        if not venue:
            continue
        family = paper_family(venue)
        if family:
            families[family] = families.get(family, 0) + 1
        else:
            label = re.sub(r"\s*\b20\d{2}\b\s*", " ", venue).strip() or venue
            unknown[label] = unknown.get(label, 0) + 1
    return families, unknown


def fetch_lab_papers():
    """Every paper record from the AdminBot service, or None when it cannot be read.

    None is not an empty lab. The collector also runs where no service is listening, and treating
    that as "no venues" would retire every automatically tracked deadline on the next sweep.
    """
    base = os.environ.get("ADMINBOT_SERVICE_BASE_URL", "http://127.0.0.1:8765").rstrip("/")
    token = os.environ.get("ADMINBOT_SERVICE_TOKEN", "").strip()
    headers = {"User-Agent": "jinesis-adminbot/1.0"}
    if token:
        headers["Authorization"] = "Bearer " + token
    papers, offset, limit = [], 0, 100
    while True:
        try:
            request = urllib.request.Request(f"{base}/papers?limit={limit}&offset={offset}", headers=headers)
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
        except Exception as error:
            print(f"WARN: paper records unavailable ({error}); lab venues keep their last sweep",
                  file=sys.stderr)
            return None
        batch = data.get("papers", [])
        papers.extend(batch)
        offset += len(batch)
        total = data.get("total")
        if not batch or len(batch) < limit or (total is not None and offset >= total):
            return papers


def lab_venue_conferences(papers, items, previous_by_id, clock, *, read_deadlines, checked_at):
    """Rows for lab venues the configured list does not already cover, plus a coverage report.

    `read_deadlines(group_ids)` returns {group_id: AoE stamp} for open Submission invitations.
    A family is covered once any main-track row exists for that edition, whatever its source, so
    a curated row always wins over an automatic one.
    """
    carried = [dict(row) for row_id, row in previous_by_id.items() if str(row_id).startswith(AUTO_ID_PREFIX)]
    if papers is None:
        return carried, []
    families, unknown = lab_venue_counts(papers)
    covered = {
        (row.get("venue_family") or paper_family(row.get("venue_group", "")), year[0])
        for row in items
        if row.get("track") == "main" and (year := re.search(r"20\d{2}", row.get("venue_group", "")))
    }
    wanted, rows = {}, []
    for family in sorted(families):
        pattern = LAB_VENUE_GROUPS.get(family)
        if not pattern:
            continue
        for offset in range(LAB_VENUE_YEAR_SPAN):
            year = clock.today.year + offset
            if (family, str(year)) in covered:
                continue
            row_id = f"{AUTO_ID_PREFIX}{family.lower()}{year}_submission"
            previous = previous_by_id.get(row_id)
            if previous and not is_sweep_due(clock, "conference", previous.get("deadline_aoe", ""),
                                             previous.get("source_checked_at")):
                rows.append(dict(previous))
                continue
            wanted[pattern.format(year=year)] = (row_id, family, year)
    deadlines = read_deadlines(sorted(wanted)) if wanted else {}
    for group_id, (row_id, family, year) in wanted.items():
        deadline = deadlines.get(group_id)
        if not deadline:
            # Not opened yet, or the read failed: keep what the last sweep saw, unobserved.
            if row_id in previous_by_id:
                rows.append(dict(previous_by_id[row_id], _source_observed=False))
            continue
        url = "https://openreview.net/group?id=" + group_id
        count = families[family]
        # An ARR venue's own Submission invitation is where reviewed papers are committed.
        commitment = family in ARR_FAMILIES
        rows.append(dict(
            id=row_id, name=f"{family} {year}", venue_type="conference", venue_family=family,
            venue_group=f"{family} {year}", track="main",
            submission_type="commitment" if commitment else "",
            deadline_label="ARR commitment" if commitment else "submission",
            deadline_aoe=deadline, deadline_timezone="UTC", notification_aoe="",
            openreview_url=url, source_url=url, link=url, homepage_url="", cfp_url="",
            deadline_source_kind="openreview", deadline_source_status="openreview_only",
            deadline_source_precision="exact",
            deadline_source_evidence=(
                f"Tracked automatically: {count} lab paper record{'s' if count != 1 else ''} "
                f"name{'' if count != 1 else 's'} {family}."),
            source_checked_at=checked_at(),
        ))
    report = [f"{family} ({count} paper{'s' if count != 1 else ''}; no known portal)"
              for family, count in sorted(families.items())
              if family not in LAB_VENUE_GROUPS
              and not any(covered_family == family for covered_family, _ in covered)]
    report += [f"{label} ({count} paper{'s' if count != 1 else ''}; unrecognized venue)"
               for label, count in sorted(unknown.items(), key=lambda entry: (-entry[1], entry[0]))[:10]]
    return rows, report
