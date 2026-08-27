#!/usr/bin/env python3
"""
AdminBot deadline collector (Output 0 data source).

Refreshes extensions/adminbot/content/deadlines/venues.json with the lab's tracked
Existing records are merged by stable id: expired or disappeared records remain,
and changed dates append revisions while the top-level fields stay the current
projection consumed by ordinary workflows.

  - Workshops -> collected from each requested family's OpenReview parent.
  - Conference milestones -> curated from official CFPs, except sources such as
      IASEAI whose OpenReview venue can be checked directly.

Times are AoE (UTC-12). Run:  python3 scripts/adminbot-deadline-collect.py
Writes venues.json and its generated UI datasets; nothing is sent.
"""
import concurrent.futures
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adminbot_deadlines import AoEClock, is_sweep_due
HERE = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, HERE)

from adminbot_deadlines import (  # noqa: E402
    ARR_FAMILIES,
    archival_status_of,
    DEADLINES_DIR,
    entry_type_of,
    milestone_of,
    SUBMISSION_COMMITMENT,
    SUBMISSION_DIRECT,
    WORKSHOP_FAMILIES,
    family_of,
    is_archival,
    venue_priority_of,
)
OUT  = os.path.join(DEADLINES_DIR, "venues.json")

# --- curated, source-verified conference milestones (AoE 23:59:59) ---
#
# The set tracked here is the guidebook's, not a wishlist (see is_archival in
# adminbot_deadlines.py, which is where the policy is written):
#
#   primary       ACL / EMNLP / NAACL main+demo, NeurIPS / ICML / ICLR / COLM /
#                 CLeaR main
#   secondary     EACL / AACL main+demo
#   non-archival  IASEAI
#   workshops     swept independently for the requested parent families; their
#                 archival status remains unknown unless a source classifies it
#   ARR           both routes into an *ACL venue -- direct submission into a cycle
#                 and commitment of an existing review -- plus the cycle itself
#
# Nothing outside that set belongs in this table. A venue inside it whose next
# round has not published a date belongs in PENDING below, not here with a guessed
# one: a wrong date on this board is planned against.
#
# Each date below is off the venue's own CFP page. Update when the next cycle's
# official CFP is announced; `python3 scripts/adminbot-deadline-collect.py` prints
# what is still missing.
CONFERENCES = [
    # Source: https://2026.aaclnet.org/calls/main_conference_papers/
    dict(id="arr_2026_may", name="ARR — May 2026 cycle (direct submission)",
         venue_type="conference", venue_group="ARR May 2026", track="cycle",
         venue_family="ARR", submission_type="direct",
         deadline_label="ARR submission", deadline_aoe="2026-05-25 23:59:59",
         notification_aoe="", link="https://2026.aaclnet.org/calls/main_conference_papers/"),
    dict(id="aacl2026_commitment", name="AACL-IJCNLP 2026 (main, ARR commitment)",
         venue_type="conference", venue_group="AACL-IJCNLP 2026", track="main",
         venue_family="AACL", submission_type="commitment",
         deadline_label="commitment", deadline_aoe="2026-08-07 23:59:59",
         notification_aoe="2026-09-07 23:59:59",
         link="https://2026.aaclnet.org/calls/main_conference_papers/"),
    dict(id="aacl2026_commitment_second", name="AACL-IJCNLP 2026 (main, second ARR commitment)",
         venue_type="conference", venue_group="AACL-IJCNLP 2026", track="main",
         venue_family="AACL", submission_type="commitment",
         deadline_label="second commitment", deadline_aoe="2026-08-25 23:59:59",
         notification_aoe="2026-09-07 23:59:59",
         link="https://2026.aaclnet.org/calls/main_conference_papers/"),
    # Source: https://2026.aaclnet.org/calls/demos/
    dict(id="aacl2026_demo", name="AACL-IJCNLP 2026 (system demonstrations)",
         venue_type="conference", venue_group="AACL-IJCNLP 2026", track="demo",
         venue_family="AACL", deadline_label="demo submission",
         deadline_aoe="2026-07-15 23:59:59", notification_aoe="2026-09-01 23:59:59",
         link="https://2026.aaclnet.org/calls/demos/"),
    dict(id="emnlp2026_commitment", name="EMNLP 2026 (main, ARR commitment)",
         venue_type="conference", venue_group="EMNLP 2026", track="main",
         submission_type="commitment",
         deadline_label="commitment", deadline_aoe="2026-08-02 23:59:59",
         notification_aoe="2026-08-20 23:59:59", link="https://2026.emnlp.org/"),
    dict(id="neurips2026_rebuttal", name="NeurIPS 2026 — Author rebuttal / discussion",
         venue_type="rebuttal", venue_group="NeurIPS 2026", track="rebuttal",
         deadline_label="rebuttal ends", deadline_aoe="2026-08-03 23:59:59",
         notification_aoe="", link="https://neurips.cc/Conferences/2026"),
    # ARR is the review pipeline the *ACL venues share, and it offers two routes to
    # the same conference. Which one is open depends on the paper's history, so both
    # are tracked as their own dated entry rather than one row somebody has to read
    # prose to interpret:
    #   direct     -- submit fresh into the cycle, then commit the reviews later
    #   commitment -- attach reviews a paper already has to a specific venue
    # The cycle itself is not a venue, so it is not archival on its own; the venue a
    # paper is eventually committed to is what decides that. Each cycle is its own
    # row: a paper aiming at any *ACL venue is choosing which cycle to enter, and the
    # commitment dates below are all downstream of one of them.
    # Source: https://aclrollingreview.org/dates
    dict(id="arr_2026_august", name="ARR — August 2026 cycle (direct submission)",
         venue_type="conference", venue_group="ARR August 2026", track="cycle",
         venue_family="ARR", submission_type="direct",
         deadline_label="ARR submission", deadline_aoe="2026-08-03 23:59:59",
         notification_aoe="", link="https://aclrollingreview.org/dates"),
    dict(id="arr_2026_october", name="ARR — October 2026 cycle (direct submission)",
         venue_type="conference", venue_group="ARR October 2026", track="cycle",
         venue_family="ARR", submission_type="direct",
         deadline_label="ARR submission", deadline_aoe="2026-10-12 23:59:59",
         notification_aoe="", link="https://aclrollingreview.org/dates"),
    # ICLR runs an abstract deadline and then the full paper a week later. That second date used
    # to live inside the display name ("abstract; paper Sep 24"), where nothing could count down to
    # it and the board could not show it as its own deadline. One row per sub-deadline; they share a
    # venue_group, which is what groups them under one conference.
    # Source: https://iclr.cc/Conferences/2027/CallForPapers
    dict(id="iclr2027_abstract", name="ICLR 2027",
         venue_type="conference", venue_group="ICLR 2027", track="main",
         deadline_label="abstract deadline", deadline_aoe="2026-09-18 23:59:59",
         notification_aoe="", link="https://iclr.cc/Conferences/2027"),
    dict(id="iclr2027_paper", name="ICLR 2027",
         venue_type="conference", venue_group="ICLR 2027", track="main",
         deadline_label="full paper", deadline_aoe="2026-09-25 23:59:59",
         notification_aoe="", link="https://iclr.cc/Conferences/2027"),
    # EACL 2027 takes the August cycle's reviews; its demo track runs its own review and
    # its own deadline, and is archival like the main track.
    # Source: https://2027.eacl.org/calls/papers/ and /calls/demos/
    dict(id="eacl2027_demo", name="EACL 2027 (system demonstrations)",
         venue_type="conference", venue_group="EACL 2027", track="demo",
         deadline_label="demo submission", deadline_aoe="2026-09-22 23:59:59",
         notification_aoe="2026-12-18 23:59:59", link="https://2027.eacl.org/calls/demos/"),
    dict(id="eacl2027_commitment", name="EACL 2027 (main, ARR commitment)",
         venue_type="conference", venue_group="EACL 2027", track="main",
         submission_type="commitment",
         deadline_label="commitment", deadline_aoe="2026-10-11 23:59:59",
         notification_aoe="2026-11-12 23:59:59", link="https://2027.eacl.org/calls/papers/"),
    # NAACL 2027 runs on the October cycle: submit into it by Oct 12, commit by Dec 20.
    # Source: https://aclrollingreview.org/dates and https://2027.naacl.org/
    dict(id="naacl2027_paper", name="NAACL 2027 (main, ARR submission)",
         venue_type="conference", venue_group="NAACL 2027", track="main",
         submission_type="direct",
         deadline_label="paper submission (ARR)", deadline_aoe="2026-10-12 23:59:59",
         notification_aoe="", link="https://2027.naacl.org/"),
    dict(id="naacl2027_commitment", name="NAACL 2027 (main, ARR commitment)",
         venue_type="conference", venue_group="NAACL 2027", track="main",
         submission_type="commitment",
         deadline_label="commitment", deadline_aoe="2026-12-20 23:59:59",
         notification_aoe="", link="https://2027.naacl.org/"),
]

# Tracked by the guidebook, but the next round has published no date yet. Listed so the
# gap is visible: an absent venue otherwise looks exactly like a venue nobody wants
# tracked, which is how ACL's own main track went missing from a board that carried a
# hundred of its workshops. main() prints these; move one into CONFERENCES the moment
# its CFP names a date, and never invent the date to close the gap early.
PENDING = [
    ("ACL 2027 (main, ARR commitment)", "https://2027.aclweb.org/"),
    ("ACL 2027 (system demonstrations)", "https://2027.aclweb.org/"),
    ("EMNLP 2027 (main, ARR commitment)", "https://2027.emnlp.org/"),
    ("EMNLP 2027 (system demonstrations)", "https://2027.emnlp.org/"),
    ("NAACL 2027 (system demonstrations)", "https://2027.naacl.org/"),
    ("AACL next round (main + demo)", "https://aaclnet.org/"),
    ("NeurIPS 2027 (main)", "https://neurips.cc/Conferences/2027"),
    ("ICML 2027 (main)", "https://icml.cc/Conferences/2027"),
    ("COLM 2027 (main)", "https://colmweb.org/"),
    ("CLeaR 2027 (main)", "https://www.cclear.cc/"),
    ("IASEAI 2027 submission (OpenReview venue exists; deadline not announced)",
     "https://openreview.net/group?id=IASEAI.org/2027/Conference"),
]

# Non-workshop venues whose OpenReview invitation is the authoritative date.
OPENREVIEW_CONFERENCES = [
    dict(id="iaseai2027_submission", name="IASEAI 2027", venue_family="IASEAI",
         venue_group="IASEAI 2027", track="main", venue_type="conference",
         deadline_label="submission", notification_aoe="",
         group_id="IASEAI.org/2027/Conference"),
]

# Curated non-NeurIPS workshops (each has its own per-workshop deadline).
# Add EMNLP 2026 workshops here as their CFPs are confirmed.
EMNLP_WORKSHOPS = [
    dict(id="emnlp2026_ws_nlp4pi",
         name="NLP4PI — 5th Workshop on NLP for Positive Impact (EMNLP 2026)",
         venue_type="workshop", venue_group="EMNLP 2026 Workshops", track="workshop",
         submission_type="commitment",
         deadline_label="ARR commitment",   # direct channel (Jul 14) already closed
         deadline_aoe="2026-08-03 23:59:59", notification_aoe="2026-08-15 23:59:59",
         homepage_url="https://sites.google.com/view/nlp4positiveimpact",
         cfp_url="https://sites.google.com/view/nlp4positiveimpact/call-for-papers-2026",
         openreview_url="https://openreview.net/group?id=EMNLP/2026/Workshop/NLP4PI_ARR_Commitment",
         source_url="https://openreview.net/group?id=EMNLP/2026/Workshop/NLP4PI_ARR_Commitment",
         source_checked_at="2026-08-24T00:00:00Z",
         link="https://openreview.net/group?id=EMNLP/2026/Workshop/NLP4PI_ARR_Commitment"),
]

# Publication policy belongs to the workshop, not to its direct/ARR deadline row.
# These workshop CFPs need a small override because OpenReview exposes the rows as
# separate groups and some homepages hide the policy on a sibling page.
WORKSHOP_POLICY_OVERRIDES = {
    "emnlp2026_ws_LUHME": dict(
        archival_status="archival", homepage_url="https://luhme.up.pt/",
        cfp_url="https://luhme.up.pt/paper-submission/"),
    "emnlp2026_ws_WNUT": dict(
        archival_status="archival", homepage_url="https://noisy-text.github.io/2026/",
        cfp_url="https://noisy-text.github.io/2026/#call-for-papers"),
    "emnlp2026_ws_NLLP": dict(
        archival_status="mixed", homepage_url="https://nllpw.org/workshop",
        cfp_url="https://nllpw.org/workshop/call/"),
    "emnlp2026_ws_PANDORA": dict(
        archival_status="mixed", homepage_url="https://pandora-workshop.github.io/",
        cfp_url="https://pandora-workshop.github.io/author"),
    "emnlp2026_ws_REALM": dict(
        archival_status="mixed", homepage_url="https://realm-workshop.github.io/",
        cfp_url="https://realm-workshop.github.io/call_for_papers/"),
}

NEURIPS_WS_SUBMISSION = "2026-08-29 23:59:59"   # official recommended (AoE)
NEURIPS_WS_NOTIF      = "2026-09-29 23:59:59"   # official hard accept/reject (AoE)

# OpenReview group prefix per family, with {year} filled from a rolling window
# rather than pinned. This runs weekly and unattended: a hardcoded year would keep
# working right up until the round it names closes, then return nothing for the
# rest of time without failing, which is the worst shape a scheduled job can have.
#
# The prefixes genuinely differ per family and were each verified against a year
# known to exist -- EMNLP is bare "EMNLP/...", EACL is "eacl.org/...", and the rest
# sit under the organisation's own domain. Guessing one wrong is silent: the parent
# simply has no children, so it looks exactly like a round that has not opened.
WORKSHOP_PARENTS = {
    "NeurIPS": "NeurIPS.cc/{year}/Workshop",
    "ICML": "ICML.cc/{year}/Workshop",
    "ICLR": "ICLR.cc/{year}/Workshop",
    "COLM": "colmweb.org/COLM/{year}/Workshop",
    "ACL": "aclweb.org/ACL/{year}/Workshop",
    "EMNLP": "EMNLP/{year}/Workshop",
    "NAACL": "aclweb.org/NAACL/{year}/Workshop",
    "EACL": "eacl.org/EACL/{year}/Workshop",
}

# Rounds whose whole workshop track shares one published date, keyed (family, year).
# Everything else takes each workshop's own stamp off its OpenReview group.
UNIFIED_ROUND_DEADLINES = {
    ("NeurIPS", 2026): (NEURIPS_WS_SUBMISSION, NEURIPS_WS_NOTIF),
}

# Sweep this year and next. Recent past rows remain in the generated dataset when
# their source still publishes them, so the history view can render them.
WORKSHOP_YEAR_SPAN = 2


def workshop_sources(today=None):
    today = today or datetime.date.today()
    out = []
    for family in WORKSHOP_FAMILIES:
        pattern = WORKSHOP_PARENTS.get(family)
        if not pattern:
            continue
        for offset in range(WORKSHOP_YEAR_SPAN):
            year = today.year + offset
            submission, notification = UNIFIED_ROUND_DEADLINES.get((family, year), ("", ""))
            out.append(dict(
                family=family, year=year,
                group=f"{family} {year} Workshops",
                id_prefix=f"{family.lower()}{year}_ws_",
                parent=pattern.format(year=year),
                deadline_aoe=submission, notification_aoe=notification))
    return out


# OpenReview rate-limits, and this sweep is now one request per workshop on top of
# one per family-year -- a few hundred in a burst, which earns a 429 partway
# through and silently truncates the board. A small gap between calls plus backoff
# on 429 keeps the whole sweep inside the budget. It runs weekly and unattended, so
# slow-and-complete beats fast-and-partial.
OPENREVIEW_GAP_SECONDS = 1.1
OPENREVIEW_RETRIES = 4

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def checked_at():
    """A day-stable UTC timestamp, so a same-day second generation is idempotent."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT00:00:00Z")


def normalize_url(value):
    """A safe absolute HTTP(S) URL, accepting host-only URLs published by OpenReview."""
    raw = str(value or "").strip()
    candidates = [
        part.strip()
        for part in re.split(r"\s*;\s*|\s+(?=https?://)", raw)
        if part.strip()
    ]
    text = next(
        (part for part in candidates if part.lower().startswith("https://")),
        candidates[0] if candidates else "",
    )
    if not text:
        return ""
    if text.startswith("//"):
        text = "https:" + text
    elif re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", text) and "://" not in text:
        return ""
    elif "://" not in text:
        text = "https://" + text
    parsed = urllib.parse.urlsplit(text)
    try:
        hostname = parsed.hostname
        parsed.port
    except ValueError:
        return ""
    if parsed.scheme not in ("http", "https") or not hostname:
        return ""
    return urllib.parse.urlunsplit(parsed)


CFP_SIGNAL = re.compile(r"(?:\bcall[\s_-]*for[\s_-]*papers?\b|\bcfp\b)", re.IGNORECASE)
GENERIC_CONFERENCE_CFP = re.compile(r"^/Conferences/20\d{2}/CallForPapers/?$", re.IGNORECASE)
NON_ARCHIVAL_SIGNAL = re.compile(
    r"\b(?:non[ -]?archiv(?:al|ed)|not (?:be )?(?:published|included in (?:the )?(?:workshop )?proceedings)|"
    r"no (?:formal |official )?proceedings|does not (?:constitute|count as) (?:a )?publication|"
    r"will not preclude subsequent publication)\b",
    re.IGNORECASE,
)
ARCHIVAL_SIGNAL = re.compile(
    r"\b(?:(?:accepted )?(?:papers?|work|submissions?) (?:will (?:be )?)?"
    r"(?:appear|be published|be included) in (?:the )?(?:workshop )?proceedings|"
    r"(?:accepted )?(?:papers?|work|submissions?) (?:will (?:be )?)?"
    r"(?:appear|be published|be included) in (?:the )?ACL Anthology)\b",
    re.IGNORECASE,
)
ALLOWED_CROSS_SUBMISSION_SIGNAL = re.compile(
    r"\b(?:(?:dual|concurrent|cross)[ -]?submissions? (?:(?:are|is)\s+)?"
    r"(?:allowed|permitted|welcome)|(?:allow|permit|welcome|accept)(?:ing)? "
    r"(?:dual|concurrent|cross)[ -]?submissions?|"
    r"(?:papers?|work|submissions?) (?:that (?:is|are) )?(?:currently )?"
    r"under review elsewhere (?:are|is) (?:allowed|permitted|welcome)|"
    r"(?:may|can) be (?:under review|concurrently submitted) elsewhere)\b",
    re.IGNORECASE,
)
PROHIBITED_CROSS_SUBMISSION_SIGNAL = re.compile(
    r"\b(?:(?:dual|concurrent|cross)[ -]?submissions? (?:(?:are|is)\s+)?"
    r"(?:not allowed|prohibited|forbidden)|(?:do not|does not|cannot|may not) "
    r"(?:allow|permit|accept) (?:dual|concurrent|cross)[ -]?submissions?|"
    r"must not be (?:submitted|under review|published) elsewhere|"
    r"(?:cannot|may not) be (?:submitted|under review) elsewhere|"
    r"not (?:currently )?(?:submitted|under review) elsewhere)\b",
    re.IGNORECASE,
)
TOPIC_SECTION_SIGNAL = re.compile(
    r"\b(?:topics?(?: of interest)? (?:include|are)|areas?(?: of interest)? (?:include|are)|"
    r"we (?:invite|welcome|accept) submissions? (?:on|about|covering)|scope includes)\b",
    re.IGNORECASE,
)

# One event key across its workshops. NeurIPS 2026 is explicitly multi-site, so the location
# remains a list rather than pretending that every attendee travels to the main Sydney meeting.
PARENT_CONFERENCE_LOCATIONS = {
    ("EMNLP", "2026"): "Budapest, Hungary",
    ("NeurIPS", "2026"): "Sydney, Australia; Atlanta, USA; Paris, France",
}


def is_generic_conference_cfp(url):
    parsed = urllib.parse.urlsplit(normalize_url(url))
    host = parsed.hostname.lower().removeprefix("www.") if parsed.hostname else ""
    return host in {"neurips.cc", "icml.cc", "iclr.cc"} and bool(
        GENERIC_CONFERENCE_CFP.fullmatch(parsed.path)
    )


class _CfpParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.anchors = []
        self.links = []
        self._link = None
        self._text = []
        self.visible_text = []
        self._hidden_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "template"}:
            self._hidden_depth += 1
        attrs = dict(attrs)
        anchor = attrs.get("id") or attrs.get("name")
        if anchor and CFP_SIGNAL.search(anchor.replace("-", " ")):
            self.anchors.append(anchor)
        if tag == "a" and attrs.get("href"):
            self._link = attrs["href"]
            self._text = []

    def handle_data(self, data):
        if not self._hidden_depth:
            self.visible_text.append(data)
        if self._link is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag in {"script", "style", "template"} and self._hidden_depth:
            self._hidden_depth -= 1
        if tag == "a" and self._link is not None:
            self.links.append((self._link, " ".join(self._text)))
            self._link = None
            self._text = []


def archival_status_from_html(html):
    """Classify only an explicit publication statement; silence is unknown."""
    parser = _CfpParser()
    parser.feed(html)
    text = " ".join(" ".join(parser.visible_text).split())
    non_archival = bool(NON_ARCHIVAL_SIGNAL.search(text))
    archival = bool(ARCHIVAL_SIGNAL.search(text))
    if non_archival and archival:
        return "mixed"
    if not non_archival and not archival:
        return "unknown"
    return "non_archival" if non_archival else "archival"


def _visible_text(html):
    parser = _CfpParser()
    parser.feed(html)
    return " ".join(" ".join(parser.visible_text).split())


def _evidence_for(text, signal):
    """The bounded sentence containing a policy signal, not an uncited whole CFP."""
    match = signal.search(text)
    if not match:
        return ""
    start = max(text.rfind(".", 0, match.start()), text.rfind("!", 0, match.start()),
                text.rfind("?", 0, match.start())) + 1
    stops = [text.find(mark, match.end()) for mark in ".!?"
             if text.find(mark, match.end()) >= 0]
    end = min(stops) + 1 if stops else min(len(text), match.end() + 220)
    return text[start:end].strip()[:400]


def cross_submission_from_html(html):
    """Return only an explicit cross-submission policy; silence and conflict stay unclear."""
    text = _visible_text(html)
    allowed = _evidence_for(text, ALLOWED_CROSS_SUBMISSION_SIGNAL)
    prohibited = _evidence_for(text, PROHIBITED_CROSS_SUBMISSION_SIGNAL)
    # FAQ headings are questions, not policies. Likewise, a restriction that begins only after
    # acceptance does not establish whether a paper may be under review elsewhere now.
    if allowed.endswith("?"):
        allowed = ""
    if prohibited.endswith("?") or re.search(
            r"\b(?:(?:if|once) accepted|after acceptance)\b", prohibited, re.IGNORECASE):
        prohibited = ""
    if bool(allowed) == bool(prohibited):
        return "unclear", ""
    return ("allowed", allowed) if allowed else ("prohibited", prohibited)


def topic_profile_from_html(html):
    """Extract a compact official topic list without using keywords as the match decision."""
    text = _visible_text(html)
    match = TOPIC_SECTION_SIGNAL.search(text)
    if not match:
        return [], ""
    tail = text[match.end():match.end() + 1600]
    stop = re.search(r"\b(?:important dates|submission guidelines|format|review process|contact)\b",
                     tail, re.IGNORECASE)
    evidence = tail[:stop.start() if stop else len(tail)].strip(" :-")[:1200]
    topics = []
    for topic in re.split(r"\s*[;•|]\s*|\s*,\s*", evidence):
        clean = re.sub(r"\s+", " ", topic).strip(" .:-")
        if clean.count("(") != clean.count(")"):
            clean = re.sub(r"[()]", "", clean)
            clean = re.sub(r"\s+", " ", clean).strip(" .:-")
        if 3 <= len(clean) <= 180 and clean.lower() not in {item.lower() for item in topics}:
            topics.append(clean)
        if len(topics) == 20:
            break
    return topics, evidence


def workshop_profile_from_html(html, source_url):
    topics, topic_evidence = topic_profile_from_html(html)
    status, policy_evidence = cross_submission_from_html(html)
    return dict(
        topic_profile=topics,
        topic_evidence=topic_evidence,
        cross_submission_status=status,
        cross_submission_evidence=policy_evidence,
        cross_submission_source_url=normalize_url(source_url),
        profile_extracted_at=checked_at(),
    )


def _merge_archival_status(*statuses):
    established = {status for status in statuses if status in {"archival", "non_archival", "mixed"}}
    if "mixed" in established or established == {"archival", "non_archival"}:
        return "mixed"
    return established.pop() if len(established) == 1 else "unknown"


def _fetch_html(url, timeout=15):
    headers = {**HTTP_HEADERS, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"}
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(2_000_000)
        charset = response.headers.get_content_charset() or "utf-8"
        return response.geturl(), body.decode(charset, errors="replace")


def discover_workshop_profile(homepage, existing="", existing_status="unknown"):
    """Return the dedicated CFP, publication policy, and bounded matching profile."""
    homepage = normalize_url(homepage)
    previous = normalize_url(existing)
    if previous == homepage or is_generic_conference_cfp(previous):
        previous = ""
    if not homepage:
        return previous, existing_status, {}
    try:
        final_homepage, html = _fetch_html(homepage)
    except Exception:
        return previous, existing_status, {}

    parser = _CfpParser()
    parser.feed(html)
    homepage_status = archival_status_from_html(html)
    base = urllib.parse.urldefrag(final_homepage)[0]
    if parser.anchors:
        anchor = urllib.parse.quote(parser.anchors[0], safe="-._~")
        source = f"{base}#{anchor}"
        return source, homepage_status, workshop_profile_from_html(html, source)

    candidates = []
    for href, text in parser.links:
        absolute = normalize_url(urllib.parse.urljoin(final_homepage, href))
        candidate_base, fragment = urllib.parse.urldefrag(absolute)
        if candidate_base == base and fragment and CFP_SIGNAL.search(fragment.replace("-", " ")):
            return absolute, homepage_status, workshop_profile_from_html(html, absolute)
        if not absolute or candidate_base == base:
            continue
        signal = f"{text} {urllib.parse.urlsplit(absolute).path} {urllib.parse.urlsplit(absolute).fragment}"
        if CFP_SIGNAL.search(signal):
            candidates.append(absolute)
    for candidate in dict.fromkeys(candidates):
        try:
            final_candidate, candidate_html = _fetch_html(candidate)
            if not is_generic_conference_cfp(final_candidate):
                return (
                    final_candidate,
                    _merge_archival_status(homepage_status,
                                           archival_status_from_html(candidate_html)),
                    workshop_profile_from_html(candidate_html, final_candidate),
                )
        except Exception:
            continue
    return previous, homepage_status, workshop_profile_from_html(html, final_homepage)


def discover_workshop_metadata(homepage, existing="", existing_status="unknown"):
    """Compatibility projection for callers that only need URL and archival status."""
    url, status, _ = discover_workshop_profile(homepage, existing, existing_status)
    return url, status


def discover_cfp_url(homepage, existing=""):
    """Return a verified dedicated CFP URL, never a homepage placeholder."""
    return discover_workshop_metadata(homepage, existing)[0]


def enrich_workshop_sources(items, previous_by_id, clock=None):
    """Re-read workshop CFP sites, on the cadence rather than all of them every run.

    This is the expensive half of the sweep -- one HTTP request per workshop site, 140 of them --
    and the half that earns a 429. A workshop within three days of its deadline is re-read daily,
    because a late extension is exactly what the board exists to catch; everything else waits a
    fortnight. A skipped workshop keeps every value the last sweep established, `profile_extracted_at`
    included, so its clock measures from the last real read.
    """
    skipped = 0
    due_ids = set()
    jobs = {}
    for item in items:
        if item.get("venue_type") != "workshop":
            continue
        previous = previous_by_id.get(item.get("id"), {})
        if clock and not is_sweep_due(
            clock,
            "workshop",
            item.get("deadline_aoe", "") or previous.get("deadline_aoe", ""),
            previous.get("profile_extracted_at"),
        ):
            skipped += 1
            continue
        due_ids.add(item.get("id"))
        homepage = normalize_url(item.get("homepage_url", ""))
        if not homepage:
            continue
        existing = normalize_url(item.get("cfp_url", ""))
        if not existing or existing == homepage:
            existing = normalize_url(previous.get("cfp_url", ""))
        if existing == homepage:
            existing = ""
        status = item.get("archival_status") or previous.get("archival_status", "unknown")
        jobs.setdefault(homepage, (existing, status))

    found = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        futures = {
            executor.submit(discover_workshop_profile, homepage, existing, status): homepage
            for homepage, (existing, status) in jobs.items()
        }
        for future in concurrent.futures.as_completed(futures):
            homepage = futures[future]
            try:
                found[homepage] = future.result()
            except Exception:
                existing, status = jobs[homepage]
                found[homepage] = (existing, status, {})

    for item in items:
        if item.get("venue_type") != "workshop":
            continue
        homepage = normalize_url(item.get("homepage_url", ""))
        previous = previous_by_id.get(item.get("id"), {})
        if clock and item.get("id") not in due_ids:
            # Not due: carry the last sweep's answers forward verbatim. Falling through would
            # overwrite them with the empty default and read as "this workshop lost its CFP".
            item["cfp_url"] = previous.get("cfp_url", item.get("cfp_url", ""))
            item["archival_status"] = previous.get(
                "archival_status", item.get("archival_status", "unknown")
            )
            for key in ("topic_profile", "topic_evidence", "cross_submission_status",
                        "cross_submission_evidence", "cross_submission_source_url",
                        "profile_extracted_at"):
                default = [] if key == "topic_profile" else ""
                item[key] = previous.get(key, item.get(key, default))
            item["link"] = (item["cfp_url"] or homepage
                            or normalize_url(item.get("openreview_url", "")))
            continue
        cfp_url, archival_status, profile = found.get(
            homepage, ("", item.get("archival_status", "unknown"), {})
        )
        item["cfp_url"] = cfp_url
        item["archival_status"] = archival_status
        for key in ("topic_profile", "topic_evidence", "cross_submission_status",
                    "cross_submission_evidence", "cross_submission_source_url",
                    "profile_extracted_at"):
            default = [] if key == "topic_profile" else ""
            item[key] = profile.get(key, previous.get(key, default))
        item["link"] = item["cfp_url"] or homepage or normalize_url(item.get("openreview_url", ""))
    if skipped:
        print(f"CFP discovery: skipped {skipped} workshop(s) still inside their sweep interval")
    print(
        f"CFP discovery: {sum(bool(url) for url, _, _ in found.values())}/{len(found)} workshop sites; "
        f"archival status established for {sum(status != 'unknown' for _, status, _ in found.values())}; "
        f"cross-submission rules established for "
        f"{sum(profile.get('cross_submission_status') in {'allowed', 'prohibited'} for _, _, profile in found.values())}"
    )


def openreview_url(group_id):
    return "https://openreview.net/group?id=" + urllib.parse.quote(group_id, safe="/")


def _openreview_get(url, timeout=30):
    candidates = [url]
    if url.startswith("https://api2.openreview.net/"):
        candidates.append(url.replace("https://api2.", "https://api.", 1))
    headers = {**HTTP_HEADERS, "Accept": "application/json,text/plain,*/*"}
    delay = 1.0
    for attempt in range(OPENREVIEW_RETRIES):
        last_error = None
        for candidate in candidates:
            time.sleep(OPENREVIEW_GAP_SECONDS)
            try:
                with urllib.request.urlopen(
                    urllib.request.Request(candidate, headers=headers), timeout=timeout
                ) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                if error.code != 429:
                    raise
                last_error = error
        if attempt == OPENREVIEW_RETRIES - 1:
            raise last_error
        retry_after = last_error.headers.get("Retry-After") if last_error.headers else None
        wait = float(retry_after) if (retry_after or "").strip().isdigit() else delay
        print(f"  rate limited; retrying in {wait:.0f}s", file=sys.stderr)
        time.sleep(wait)
        delay *= 2
    raise RuntimeError("unreachable")


def _group_value(content, key):
    v = (content or {}).get(key)
    return v.get("value") if isinstance(v, dict) else v


def fetch_workshop_source(source, previous_by_id=None):
    """Every workshop under one family-year's OpenReview parent group."""
    parent = source["parent"]
    data = _openreview_get(f"https://api2.openreview.net/groups?parent={parent}", timeout=60)
    pref = parent + "/"
    out = {}
    previous_by_id = previous_by_id or {}
    for g in data.get("groups", []):
        gid = g.get("id", "")
        if not gid.startswith(pref):
            continue
        rest = gid[len(pref):]
        if "/" in rest:          # skip /Authors, /Reviewers, ... subgroups
            continue
        c = g.get("content", {}) or {}
        # A round without a unified date takes each workshop's own stamp when
        # OpenReview carries one. No date means no countdown to show, so it is left
        # out rather than published with a placeholder somebody would plan against.
        item_id = source["id_prefix"] + rest
        previous = previous_by_id.get(item_id, {})
        observed_deadline = source["deadline_aoe"] or _openreview_submission_deadline(gid)
        deadline = observed_deadline or previous.get("deadline_aoe", "")
        if not deadline:
            continue
        route = _submission_type(source["family"], rest)
        homepage = normalize_url(_group_value(c, "web") or _group_value(c, "website"))
        review_url = openreview_url(gid)
        out[rest] = dict(
            id=item_id,
            name=_group_value(c, "title") or _group_value(c, "name") or rest,
            venue_type="workshop", venue_group=source["group"], track="workshop",
            venue_family=source["family"], submission_type=route,
            deadline_label=("ARR commitment" if route == SUBMISSION_COMMITMENT else "submission"),
            deadline_aoe=deadline,
            notification_aoe=source["notification_aoe"],
            homepage_url=homepage,
            cfp_url="",
            openreview_url=review_url,
            source_url=review_url,
            _source_observed=bool(observed_deadline),
            source_checked_at=(checked_at() if observed_deadline
                               else previous.get("source_checked_at", "")),
            link=homepage or review_url)
    return [out[k] for k in sorted(out)]


def _aoe_stamp(duedate_ms):
    """OpenReview's UTC epoch-ms duedate as the AoE wall-clock stamp this schema stores.

    AoE is UTC-12, so the same instant written in AoE is twelve hours earlier --
    which is why a CFP that closes "23:59 AoE on the 24th" appears here as
    11:59 UTC on the 25th. Storing the UTC clock instead would move every workshop
    a day later and turn "due tomorrow" into "due today" for the whole board.
    """
    utc = datetime.datetime.fromtimestamp(duedate_ms / 1000, datetime.timezone.utc)
    return (utc - datetime.timedelta(hours=12)).strftime("%Y-%m-%d %H:%M:%S")


def _openreview_submission_deadline(group_id):
    """The AoE deadline on a workshop's Submission invitation, or "".

    The deadline is not on the group -- its `date`/`start_date` are when the
    workshop *runs*, which is months after the CFP closes and would be badly wrong
    to count down to. It lives on the venue's Submission invitation, one request
    per workshop.

    An unavailable or expired invitation yields no current observation. The caller
    may retain a previous value, but must not advance its source-check timestamp.
    """
    url = f"https://api2.openreview.net/invitations?id={urllib.parse.quote(group_id, safe='/')}/-/Submission"
    try:
        data = _openreview_get(url)
    except Exception:
        return ""
    for invitation in data.get("invitations") or []:
        duedate = invitation.get("duedate")
        if isinstance(duedate, (int, float)) and duedate > 0:
            return _aoe_stamp(duedate)
    return ""


def fetch_openreview_conferences(previous_by_id=None, clock=None):
    """Collect tracked standalone venues once their Submission invitation exists.

    Re-read on the fortnightly cadence (see is_sweep_due). A conference whose entry is still
    inside its interval is carried forward from the previous sweep untouched -- including its
    `source_checked_at`, so the clock measures from the last real read rather than restarting
    every run.
    """
    previous_by_id = previous_by_id or {}
    entries = []
    for source in OPENREVIEW_CONFERENCES:
        group_id = source["group_id"]
        previous = previous_by_id.get(source["id"])
        if clock and previous and not is_sweep_due(
            clock, previous.get("entry_type", ""), previous.get("deadline_aoe", ""),
            previous.get("source_checked_at"),
        ):
            entries.append(dict(previous))
            continue
        try:
            data = _openreview_get(
                "https://api2.openreview.net/groups?id="
                + urllib.parse.quote(group_id, safe="/")
            )
            group = next((g for g in data.get("groups", []) if g.get("id") == group_id), None)
            deadline = _openreview_submission_deadline(group_id)
        except Exception as error:
            print(f"WARN: {source['name']} fetch failed ({error})", file=sys.stderr)
            continue
        if not group or not deadline:
            continue
        content = group.get("content", {}) or {}
        homepage = normalize_url(_group_value(content, "web") or _group_value(content, "website"))
        review_url = openreview_url(group_id)
        entries.append(dict(
            **{key: value for key, value in source.items() if key != "group_id"},
            deadline_aoe=deadline,
            homepage_url=homepage,
            cfp_url="",
            openreview_url=review_url,
            source_url=review_url,
            source_checked_at=checked_at(),
            link=homepage or review_url,
        ))
    return entries


# OpenReview names an ARR commitment venue by suffixing the group, which is the
# only machine-readable signal for which of the two routes a workshop is offering.
ARR_COMMITMENT_SUFFIX = "_arr_commitment"


def _submission_type(family, group_name):
    if family not in ARR_FAMILIES:
        return ""
    return (SUBMISSION_COMMITMENT if group_name.lower().endswith(ARR_COMMITMENT_SUFFIX)
            else SUBMISSION_DIRECT)


def fetch_workshops(previous_by_id=None):
    """Sweep every tracked family across the year window.

    Returns (entries, families that errored). A parent that simply has no children
    is not a failure -- that is what an unopened round looks like -- so only a
    transport/parse error marks its family for fallback.
    """
    entries, failures = [], []
    for source in workshop_sources():
        try:
            found = fetch_workshop_source(source, previous_by_id)
            print(
                f"OpenReview: {source['family']} {source['year']} -> "
                f"{len(found)} publishable workshops"
            )
            entries += found
        except Exception as e:
            print(f"WARN: {source['family']} {source['year']} fetch failed ({e})", file=sys.stderr)
            if source["family"] not in failures:
                failures.append(source["family"])
    return entries, failures


def classify(item):
    """Stamp the independent venue classifications onto one entry.

    Derived rather than hand-written per venue: 100+ workshops arrive from
    OpenReview with no human in the loop, and a field somebody has to remember to
    set on each of them is a field that will be wrong. An entry may still declare
    `venue_family` itself when the name does not carry it (IASEAI, ARR).
    """
    item.pop("group_label", None)
    item.pop("_source_observed", None)
    family = item.get("venue_family") or family_of(item.get("venue_group", ""), item.get("name", ""))
    item["venue_family"] = family
    item.setdefault("submission_type", "")
    item["entry_type"] = entry_type_of(
        item.get("venue_type", ""), item.get("track", ""), item["submission_type"]
    )
    policy_id = re.sub(r"_ARR_Commitment$", "", item.get("id", ""))
    policy_override = WORKSHOP_POLICY_OVERRIDES.get(policy_id, {})
    default_status = archival_status_of(family, item.get("track", ""))
    status = item.get("archival_status") if item.get("entry_type") == "workshop" else default_status
    # NeurIPS 2026 workshop guidance is explicit: every workshop paper is
    # non-archival and absent from proceedings. A separate journal invitation
    # on a workshop site does not change the workshop paper's status.
    if item.get("entry_type") == "workshop" and family == "NeurIPS":
        status = "non_archival"
    if policy_override:
        status = policy_override["archival_status"]
    item["archival_status"] = (
        status if status in {"archival", "non_archival", "mixed", "unknown"} else default_status
    )
    item["venue_priority"] = venue_priority_of(family, item.get("track", ""))
    # Kept while older calendar/matcher consumers migrate. New surfaces use the
    # explicit status above so an unknown venue is never presented as safe.
    item["archival"] = item["archival_status"] == "archival"
    if item["entry_type"] == "workshop":
        legacy_link = normalize_url(item.get("link", ""))
        homepage = normalize_url(policy_override.get("homepage_url", item.get("homepage_url", "")))
        if not homepage and "openreview.net/group" not in legacy_link:
            homepage = legacy_link
        review_url = normalize_url(item.get("openreview_url", ""))
        if not review_url:
            match = re.search(r"\b(20\d{2})\b", item.get("venue_group", ""))
            pattern = WORKSHOP_PARENTS.get(family)
            code = item.get("id", "").split("_ws_", 1)
            if match and pattern and len(code) == 2:
                gid = pattern.format(year=int(match.group(1))) + "/" + code[1]
                review_url = openreview_url(gid)
        item["homepage_url"] = homepage
        item["cfp_url"] = normalize_url(policy_override.get("cfp_url", item.get("cfp_url", "")))
        item["openreview_url"] = review_url
        item["source_url"] = normalize_url(item.get("source_url", "")) or review_url
        item.setdefault("source_checked_at", "")
        item["link"] = item["cfp_url"] or homepage or review_url
        year_match = re.search(r"\b(20\d{2})\b", item.get("venue_group", ""))
        year = year_match.group(1) if year_match else "unknown"
        item["parent_conference_key"] = f"{family.lower()}-{year}"
        item["conference_location"] = PARENT_CONFERENCE_LOCATIONS.get((family, year), "")
        topics = item.get("topic_profile")
        item["topic_profile"] = topics if isinstance(topics, list) and topics else [item["name"]]
        if not str(item.get("topic_evidence", "")).strip():
            item["topic_evidence"] = "Workshop title from its official listing."
        if item.get("cross_submission_status") not in {"allowed", "prohibited", "unclear"}:
            item["cross_submission_status"] = "unclear"
        if not str(item.get("cross_submission_evidence", "")).strip():
            item["cross_submission_evidence"] = (
                "No explicit cross-submission rule was found on the collected CFP."
            )
        item["cross_submission_source_url"] = (
            normalize_url(item.get("cross_submission_source_url", "")) or item["cfp_url"]
            or item["source_url"]
        )
        item.setdefault("profile_extracted_at", "")
    else:
        item["link"] = normalize_url(item.get("link", ""))
        item["source_url"] = normalize_url(item.get("source_url", "")) or item["link"]
        item.setdefault("source_checked_at", "")
    item["milestone"] = milestone_of(item.get("deadline_label", ""), item["submission_type"])
    return item


REVISION_FIELDS = ("deadline_aoe", "notification_aoe", "deadline_label", "link")
REVISION_CHANGE_FIELDS = ("deadline_aoe", "notification_aoe", "deadline_label")


def canonical_venue_identity(item):
    """Use an existing venue/catalog identity, separate from the dated row id."""
    deadline_id = item["id"]
    family = item.get("venue_family", "")
    track = item.get("track", "")
    if item.get("entry_type") == "workshop":
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(item.get("openreview_url", "")).query)
        group_id = (query.get("id") or [""])[0]
        return re.sub(r"_ARR_Commitment$", "", group_id, flags=re.IGNORECASE) or deadline_id
    if track == "demo" and family:
        return f"{family}-demo"
    if track == "main" and family in ARR_FAMILIES:
        return f"{family}-main"
    if track == "main" and family:
        return family
    return deadline_id


def merge_history(item, previous=None, stale=False):
    """Keep one current projection while retaining every observed deadline revision."""
    previous = previous or {}
    revisions = []
    for raw_revision in previous.get("revisions", []):
        revision = dict(raw_revision)
        if revisions and all(
            revisions[-1].get(key, "") == revision.get(key, "")
            for key in REVISION_CHANGE_FIELDS
        ):
            revisions[-1] = revision
        else:
            revisions.append(revision)
    if previous and not revisions:
        revisions.append(dict(
            observed_at=previous.get("source_checked_at") or checked_at(),
            **{key: previous.get(key, "") for key in REVISION_FIELDS},
        ))
    projection = {key: item.get(key, "") for key in REVISION_FIELDS}
    if not revisions or any(
        revisions[-1].get(key, "") != projection[key]
        for key in REVISION_CHANGE_FIELDS
    ):
        revisions.append(dict(observed_at=checked_at(), **projection))
    else:
        revisions[-1]["link"] = projection["link"]

    deadline_id = item["id"]
    venue_id = canonical_venue_identity(item)
    previous_deadline_id = previous.get("deadline_id") or previous.get("id")
    aliases = list(dict.fromkeys([venue_id, deadline_id, previous_deadline_id]))
    aliases = [alias for alias in aliases if alias]
    item.update(
        deadline_id=deadline_id,
        venue_id=venue_id,
        venue_aliases=aliases,
        revisions=revisions,
        stale=stale,
    )
    return item


def main():
    try:
        previous_doc = json.load(open(OUT))
    except Exception:
        previous_doc = {}
    previous_items = previous_doc.get("items", [])
    previous_has_history = previous_doc.get("history_version") == 1
    previous_by_id = {item.get("id"): item for item in previous_items if item.get("id")}
    # One clock for the whole run, so every cadence decision agrees about "now" and a sweep that
    # straddles midnight cannot re-read half the board on one interval and half on another.
    clock = AoEClock.resolve()
    items = list(CONFERENCES) + list(EMNLP_WORKSHOPS) + fetch_openreview_conferences(
        previous_by_id, clock
    )
    fetched, failures = fetch_workshops(previous_by_id)
    items += fetched
    observed_ids = {
        item["id"] for item in items
        if item.get("_source_observed", True)
    }
    fallback_ids = set()
    # Fail soft per family: one conference's OpenReview group being absent (its
    # workshop round has not opened yet, which is the normal state for most of the
    # year) must not drop the families that did answer. Only a family that failed
    # falls back to what the last sweep stored for it.
    if failures:
        print(f"WARN: {len(failures)} workshop source(s) failed: {', '.join(failures)}", file=sys.stderr)
        try:
            kept = [
                x for x in previous_items
                if x.get("venue_type") == "workshop" and x.get("venue_family") in failures
            ]
            fallback_ids.update(item["id"] for item in kept)
            items += kept
            print(f"kept {len(kept)} workshop entries from the previous sweep", file=sys.stderr)
        except Exception:
            pass

    enrich_workshop_sources(items, previous_by_id, clock)
    items = [classify(x) for x in items]
    # Ids must stay unique: a family kept from the previous sweep can collide with
    # one that was also fetched this time.
    positions, unique = {}, []
    for item in items:
        position = positions.get(item["id"])
        if position is not None:
            if item.get("source_checked_at") and not unique[position].get("source_checked_at"):
                unique[position] = item
            continue
        positions[item["id"]] = len(unique)
        unique.append(item)
    items = [
        merge_history(
            item,
            previous_by_id.get(item["id"]),
            (bool(previous_by_id.get(item["id"], {}).get("stale")) and previous_has_history
             if item["id"] in fallback_ids else item["id"] not in observed_ids),
        )
        for item in unique
    ]
    current_ids = {item["id"] for item in items}
    for deadline_id, previous in previous_by_id.items():
        if deadline_id not in current_ids:
            items.append(merge_history(classify(dict(previous)), previous, stale=True))
    items.sort(key=lambda x: (x["deadline_aoe"], x["name"]))
    doc = dict(history_version=1, timezone="AoE (UTC-12)",
               note=("Current projections with append-only deadline revisions. "
                     "NeurIPS 2026 workshops use the official unified "
                     "deadline (submission 2026-08-29, hard accept/reject 2026-09-29)."),
               count=len(items), items=items)
    json.dump(doc, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"wrote {OUT} with {len(items)} items")

    # The checked-in HTML is also directly runnable, so keep its embedded data in
    # lockstep with the canonical JSON. The generated TypeScript wrapper replaces
    # this array at request time, but the standalone file has no such injection.
    board_path = os.path.join(DEADLINES_DIR, "deadlines-board.html")
    board = open(board_path).read()
    board, replacements = re.subn(
        r"const DATA = \[.*?\];\n",
        "const DATA = " + json.dumps(items, ensure_ascii=False, indent=2) + ";\n",
        board,
        count=1,
        flags=re.DOTALL,
    )
    if replacements != 1:
        raise RuntimeError("standalone deadline board has no replaceable DATA array")
    open(board_path, "w").write(board)
    print(f"wrote {board_path}")

    # keep the served-page dataset (Output 0 Control-UI surface) in sync
    ds = os.path.join(HERE, "..", "extensions", "adminbot", "src", "workflows", "deadlines", "generated", "dataset.ts")
    with open(ds, "w") as f:
        f.write("// Generated from extensions/adminbot/content/deadlines/venues.json by\n"
                "// scripts/adminbot-deadline-collect.py. Do not hand-edit; regenerate instead.\n\n"
                "export const DEADLINE_VENUES = "
                + json.dumps(items, ensure_ascii=False, indent=2) + " as const;\n")
    print(f"wrote {ds}")

    # keep the bundled Control-UI tab dataset in sync (ui/src/ui/adminbot/data/deadlines.ts)
    keys = ["id", "name", "venue_type", "venue_group", "track", "venue_family",
            "entry_type", "archival_status", "venue_priority", "archival",
            "submission_type", "milestone",
            "deadline_label", "deadline_aoe", "notification_aoe", "link",
            "homepage_url", "cfp_url", "openreview_url", "source_url", "source_checked_at",
            "deadline_id", "venue_id", "venue_aliases", "revisions", "stale"]
    slim = [{k: it.get(k, "") for k in keys} for it in items]
    ui_ds = os.path.join(HERE, "..", "ui", "src", "ui", "adminbot", "data", "deadlines.ts")
    with open(ui_ds, "w") as f:
        f.write("// Generated from extensions/adminbot/content/deadlines/venues.json by\n"
                "// scripts/adminbot-deadline-collect.py. Do not hand-edit; regenerate instead.\n\n"
                "export type DeadlineRevision = {\n"
                "  observed_at: string;\n  deadline_aoe: string;\n"
                "  notification_aoe?: string;\n  deadline_label?: string;\n  link?: string;\n};\n\n"
                "export type DeadlineVenue = {\n"
                "  id: string;\n  name: string;\n  venue_type: string;\n  venue_group: string;\n"
                "  /** Stable dated-deadline identity; equal to the legacy id. */\n"
                "  deadline_id: string;\n"
                "  /** Canonical venue identity, with every accepted legacy form listed below. */\n"
                "  venue_id: string;\n  venue_aliases: string[];\n"
                "  revisions: DeadlineRevision[];\n  stale: boolean;\n"
                "  track?: string;\n"
                "  /** Conference family, e.g. \"EMNLP\". Empty when it is not one the lab tracks. */\n"
                "  venue_family?: string;\n"
                "  entry_type: \"main_conference\" | \"demo_track\" | \"workshop\" |\n"
                "    \"arr_direct_submission\" | \"arr_commitment\" | \"rebuttal\" | \"other\";\n"
                "  archival_status: \"archival\" | \"non_archival\" | \"mixed\" | \"unknown\";\n"
                "  venue_priority: \"primary\" | \"secondary\" | \"standard\";\n"
                "  /** Compatibility boolean. New consumers use archival_status. */\n"
                "  archival?: boolean;\n"
                "  /** ARR route: \"direct\" submits fresh, \"commitment\" attaches existing reviews. */\n"
                "  submission_type?: string;\n"
                "  /** Which sub-deadline this row is: abstract, full_paper, camera_ready, ...\n"
                "   *  See MILESTONES in scripts/adminbot_deadlines.py. Empty when unclassified. */\n"
                "  milestone?: string;\n"
                "  deadline_label: string;\n  deadline_aoe: string;\n"
                "  notification_aoe?: string;\n  link?: string;\n"
                "  homepage_url?: string;\n  cfp_url?: string;\n  openreview_url?: string;\n"
                "  source_url?: string;\n  source_checked_at?: string;\n};\n\n"
                "export const DEADLINE_VENUES: DeadlineVenue[] = "
                + json.dumps(slim, ensure_ascii=False, indent=2) + ";\n")
    print(f"wrote {ui_ds}")

    # Coverage report, not a failure: these are venues the guidebook tracks whose next
    # round has not announced a date. Printed every run so the gap stays visible.
    if PENDING:
        print(f"\n{len(PENDING)} tracked venue(s) awaiting an announced date:")
        for name, where in PENDING:
            print(f"  - {name}  ({where})")


if __name__ == "__main__":
    main()
