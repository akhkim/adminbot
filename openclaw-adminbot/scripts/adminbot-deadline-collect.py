#!/usr/bin/env python3
"""
AdminBot deadline collector (Output 0 data source).

Refreshes extensions/adminbot/content/deadlines/venues.json with the lab's UPCOMING
submission/rebuttal deadlines:

  - NeurIPS 2026 workshops  -> collected live from OpenReview
      (group parent = NeurIPS.cc/2026/Workshop). All workshops share the
      OFFICIAL unified NeurIPS deadline: submission 2026-08-29 AoE,
      hard accept/reject 2026-09-29 AoE.
  - Conference milestones    -> curated + source-verified (aideadlines.org /
      ACL Rolling Review / official CFPs). Kept as a small hand-checked table
      because the freeform venues change slowly and must be exact.

Times are AoE (UTC-12). Run:  python3 scripts/adminbot-deadline-collect.py
Only OUTPUT is venues.json; nothing is sent.
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request, datetime
HERE = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, HERE)

from adminbot_deadlines import (  # noqa: E402
    ARR_FAMILIES,
    DEADLINES_DIR,
    milestone_of,
    SUBMISSION_COMMITMENT,
    SUBMISSION_DIRECT,
    WORKSHOP_FAMILIES,
    family_of,
    is_archival,
)
OUT  = os.path.join(DEADLINES_DIR, "venues.json")

# --- curated, source-verified upcoming conference milestones (AoE 23:59:59) ---
#
# The set tracked here is the guidebook's, not a wishlist (see is_archival in
# adminbot_deadlines.py, which is where the policy is written):
#
#   archival      main and demo tracks of ACL / EMNLP / NAACL / EACL, and
#                 NeurIPS / ICML / ICLR / COLM / CLeaR
#   non-archival  IASEAI, plus the workshops of every family above except CLeaR
#                 (swept live from OpenReview, not listed here)
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
    ("EMNLP 2027 (main + demo)", "https://2027.emnlp.org/"),
    ("NAACL 2027 (system demonstrations)", "https://2027.naacl.org/"),
    ("NeurIPS 2027 (main)", "https://neurips.cc/Conferences/2027"),
    ("ICML 2027 (main)", "https://icml.cc/Conferences/2027"),
    ("COLM 2027 (main)", "https://colmweb.org/"),
    ("CLeaR 2027 (main)", "https://www.cclear.cc/"),
    ("IASEAI 2027 (non-archival)", "https://www.iaseai.org/"),
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
         link="https://openreview.net/group?id=EMNLP/2026/Workshop/NLP4PI_ARR_Commitment"),
]

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

# Only upcoming deadlines are tracked, so this year and next is the whole window a
# workshop round can open in.
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
OPENREVIEW_GAP_SECONDS = 0.25
OPENREVIEW_RETRIES = 4


def _openreview_get(url, timeout=30):
    delay = 1.0
    for attempt in range(OPENREVIEW_RETRIES):
        time.sleep(OPENREVIEW_GAP_SECONDS)
        req = urllib.request.Request(url, headers={"User-Agent": "jinesis-adminbot/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == OPENREVIEW_RETRIES - 1:
                raise
            retry_after = e.headers.get("Retry-After") if e.headers else None
            wait = float(retry_after) if (retry_after or "").strip().isdigit() else delay
            print(f"  rate limited; retrying in {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)
            delay *= 2
    raise RuntimeError("unreachable")


def _group_value(content, key):
    v = (content or {}).get(key)
    return v.get("value") if isinstance(v, dict) else v


def fetch_workshop_source(source):
    """Every workshop under one family-year's OpenReview parent group."""
    parent = source["parent"]
    data = _openreview_get(f"https://api2.openreview.net/groups?parent={parent}", timeout=60)
    pref = parent + "/"
    out = {}
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
        deadline = source["deadline_aoe"] or _openreview_submission_deadline(gid)
        if not deadline:
            continue
        route = _submission_type(source["family"], rest)
        out[rest] = dict(
            id=source["id_prefix"] + rest,
            name=_group_value(c, "title") or _group_value(c, "name") or rest,
            venue_type="workshop", venue_group=source["group"], track="workshop",
            venue_family=source["family"], submission_type=route,
            deadline_label=("ARR commitment" if route == SUBMISSION_COMMITMENT else "submission"),
            deadline_aoe=deadline,
            notification_aoe=source["notification_aoe"],
            link=(_group_value(c, "web") or _group_value(c, "website")
                  or f"https://openreview.net/group?id={gid}"))
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

    An expired invitation answers 400, which is the API's way of saying the
    deadline has already passed. That is not an error worth reporting: this file
    only carries upcoming deadlines, so it is exactly the entries we mean to drop.
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


# OpenReview names an ARR commitment venue by suffixing the group, which is the
# only machine-readable signal for which of the two routes a workshop is offering.
ARR_COMMITMENT_SUFFIX = "_arr_commitment"


def _submission_type(family, group_name):
    if family not in ARR_FAMILIES:
        return ""
    return (SUBMISSION_COMMITMENT if group_name.lower().endswith(ARR_COMMITMENT_SUFFIX)
            else SUBMISSION_DIRECT)


def fetch_workshops():
    """Sweep every tracked family across the year window.

    Returns (entries, families that errored). A parent that simply has no children
    is not a failure -- that is what an unopened round looks like -- so only a
    transport/parse error marks its family for fallback.
    """
    entries, failures = [], []
    for source in workshop_sources():
        try:
            found = fetch_workshop_source(source)
            if found:
                print(f"OpenReview: {source['family']} {source['year']} -> {len(found)} workshops")
            entries += found
        except Exception as e:
            print(f"WARN: {source['family']} {source['year']} fetch failed ({e})", file=sys.stderr)
            if source["family"] not in failures:
                failures.append(source["family"])
    return entries, failures


def classify(item):
    """Stamp venue_family / archival onto one entry.

    Derived rather than hand-written per venue: 100+ workshops arrive from
    OpenReview with no human in the loop, and a field somebody has to remember to
    set on each of them is a field that will be wrong. An entry may still declare
    `venue_family` itself when the name does not carry it (IASEAI, ARR).
    """
    family = item.get("venue_family") or family_of(item.get("venue_group", ""), item.get("name", ""))
    item["venue_family"] = family
    item["archival"] = is_archival(family, item.get("track", ""))
    item.setdefault("submission_type", "")
    item["milestone"] = milestone_of(item.get("deadline_label", ""), item["submission_type"])
    return item


def main():
    items = list(CONFERENCES) + list(EMNLP_WORKSHOPS)
    fetched, failures = fetch_workshops()
    items += fetched
    # Fail soft per family: one conference's OpenReview group being absent (its
    # workshop round has not opened yet, which is the normal state for most of the
    # year) must not drop the families that did answer. Only a family that failed
    # falls back to what the last sweep stored for it.
    if failures:
        print(f"WARN: {len(failures)} workshop source(s) failed: {', '.join(failures)}", file=sys.stderr)
        try:
            prev = json.load(open(OUT))
            kept = [
                x for x in prev.get("items", [])
                if x.get("venue_type") == "workshop" and x.get("venue_family") in failures
            ]
            items += kept
            print(f"kept {len(kept)} workshop entries from the previous sweep", file=sys.stderr)
        except Exception:
            pass

    items = [classify(x) for x in items]
    # Ids must stay unique: a family kept from the previous sweep can collide with
    # one that was also fetched this time.
    seen, unique = set(), []
    for item in items:
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        unique.append(item)
    items = unique
    items.sort(key=lambda x: (x["deadline_aoe"], x["name"]))
    doc = dict(timezone="AoE (UTC-12)",
               note=("Upcoming only. NeurIPS 2026 workshops use the official unified "
                     "deadline (submission 2026-08-29, hard accept/reject 2026-09-29)."),
               count=len(items), items=items)
    json.dump(doc, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"wrote {OUT} with {len(items)} items")

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
            "archival", "submission_type", "milestone",
            "deadline_label", "deadline_aoe", "notification_aoe", "link"]
    slim = [{k: it.get(k, "") for k in keys} for it in items]
    ui_ds = os.path.join(HERE, "..", "ui", "src", "ui", "adminbot", "data", "deadlines.ts")
    with open(ui_ds, "w") as f:
        f.write("// Generated from extensions/adminbot/content/deadlines/venues.json by\n"
                "// scripts/adminbot-deadline-collect.py. Do not hand-edit; regenerate instead.\n\n"
                "export type DeadlineVenue = {\n"
                "  id: string;\n  name: string;\n  venue_type: string;\n  venue_group: string;\n"
                "  track?: string;\n"
                "  /** Conference family, e.g. \"EMNLP\". Empty when it is not one the lab tracks. */\n"
                "  venue_family?: string;\n"
                "  /** True when publishing here consumes the paper. See is_archival in\n"
                "   *  scripts/adminbot_deadlines.py, which is where the policy is written. */\n"
                "  archival?: boolean;\n"
                "  /** ARR route: \"direct\" submits fresh, \"commitment\" attaches existing reviews. */\n"
                "  submission_type?: string;\n"
                "  /** Which sub-deadline this row is: abstract, full_paper, camera_ready, ...\n"
                "   *  See MILESTONES in scripts/adminbot_deadlines.py. Empty when unclassified. */\n"
                "  milestone?: string;\n"
                "  deadline_label: string;\n  deadline_aoe: string;\n"
                "  notification_aoe?: string;\n  link?: string;\n};\n\n"
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
