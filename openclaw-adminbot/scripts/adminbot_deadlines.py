"""Shared building blocks for the AdminBot deadline scripts (Outputs 0/1/2).

The collector, matcher, digest and reminder scripts all need the same four
things: where the dataset lives, how to turn an AoE stamp into a real instant,
how urgent a deadline is, and how to hand a message to Slack. Each script used
to carry its own copy, so `aoe_utc` existed twice byte-for-byte and the urgency
thresholds existed in three languages. Import from here instead.

Underscored module name (not hyphenated like the scripts) so it is importable.
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(HERE, ".."))
DEADLINES_DIR = os.path.join(REPO_ROOT, "extensions", "adminbot", "content", "deadlines")

_MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Days-remaining bands, most urgent first. The Control UI tab
# (ui/src/ui/views/deadlines.ts) and the static board render the same bands;
# change all three together or the board and the Slack digest disagree.
URGENCY_BANDS = ((3, "🔴"), (7, "🟠"), (30, "🟡"))
URGENCY_DEFAULT = "🟢"


# --- archival classification -------------------------------------------------
#
# Whether submitting somewhere burns the paper. An archival venue publishes it in
# proceedings, so the work cannot then be submitted to a second archival venue; a
# non-archival one (a workshop, IASEAI) does not, so the same paper can go on to a
# real conference afterwards. That distinction decides whether a deadline is a
# commitment or an opportunity, which is why the board separates them rather than
# listing 100+ dates in one column.
#
# This is the single place the policy is written. The collector stamps `archival`
# onto every venue from here, so the Control UI, the served board, the calendar
# publisher and the reminder cadence all read a field rather than each re-deriving
# a rule -- the same reason the mandatory profile fields ended up in one list.
#
# Source: Zhijing's guidebook (see content/deadlines/README.md).

# The *ACL family. Main and demo tracks are archival; their workshops are not.
# All four run submissions through ACL Rolling Review.
ARR_FAMILIES = ("ACL", "EMNLP", "NAACL", "EACL")

# ML conferences whose main track is archival. CLeaR is deliberately here and
# deliberately absent from the workshop sweep below: the lab tracks its main
# track only.
ML_ARCHIVAL_FAMILIES = ("NeurIPS", "ICML", "ICLR", "COLM", "CLeaR")

# Families whose workshops the lab tracks. CLeaR is not among them.
WORKSHOP_FAMILIES = ARR_FAMILIES + ("NeurIPS", "ICML", "ICLR", "COLM")

# Non-archival by nature: submitting does not consume the paper.
NON_ARCHIVAL_FAMILIES = ("IASEAI",)

# Tracks that count as the archival part of an archival venue. Anything else
# under the same family -- a workshop, a findings-style companion, a rebuttal --
# is not a submission that burns the paper.
ARCHIVAL_TRACKS = ("main", "demo")

ALL_FAMILIES = tuple(
    dict.fromkeys(ARR_FAMILIES + ML_ARCHIVAL_FAMILIES + WORKSHOP_FAMILIES + NON_ARCHIVAL_FAMILIES)
)


def is_archival(family: str, track: str) -> bool:
    """True when publishing here consumes the paper.

    Deliberately closed: a family nobody has classified is treated as
    non-archival rather than guessed at, because the expensive mistake is telling
    someone a venue is safe to submit to twice when it is not... and the reverse
    error (calling an archival venue non-archival) is the one that would do that.
    So an unknown family is *not* archival, and it also does not reach the board's
    archival column, where a wrong entry would be read as advice.
    """
    if family in NON_ARCHIVAL_FAMILIES:
        return False
    if family in ARR_FAMILIES or family in ML_ARCHIVAL_FAMILIES:
        return track in ARCHIVAL_TRACKS
    return False


def family_of(venue_group: str, name: str = "") -> str:
    """The venue family a group belongs to, or "" when it is not one the lab tracks.

    Matched on the group first ("EMNLP 2026 Workshops" -> EMNLP) and the display
    name second, so an OpenReview title that names its conference still classifies
    when the group is generic. Longest match wins so NAACL is never read as ACL.
    """
    haystack = f"{venue_group} {name}".upper()
    for candidate in sorted(ALL_FAMILIES, key=len, reverse=True):
        if candidate.upper() in haystack:
            return candidate
    return ""


# --- sub-deadlines ------------------------------------------------------------
#
# A venue is not one date. A conference typically runs an abstract deadline, then
# the full paper, then rebuttal, then camera-ready; an ARR venue runs a direct
# submission and a commitment. Each is stored as its own dated row sharing a
# `venue_group`, which is what lets the board group them under one conference and
# count down to each separately. `milestone` is the machine-readable name for
# which one a row is, so ordering and labelling do not depend on parsing prose out
# of `deadline_label`.
#
# Ordered as a paper meets them, which is the order the board lists them in.
MILESTONES = (
    "abstract",
    "direct_submission",
    "full_paper",
    "commitment",
    "rebuttal",
    "notification",
    "camera_ready",
)

MILESTONE_LABELS = {
    "abstract": "Abstract",
    "direct_submission": "Direct submission",
    "full_paper": "Full paper",
    "commitment": "ARR commitment",
    "rebuttal": "Rebuttal ends",
    "notification": "Notification",
    "camera_ready": "Camera-ready",
}

# Free-text `deadline_label` values already in the dataset, mapped onto the closed
# set above. Anything unrecognised keeps its own label and sorts last, so an
# unclassified date is still shown rather than dropped.
_MILESTONE_FROM_LABEL = {
    "abstract deadline": "abstract",
    "abstract": "abstract",
    "submission": "direct_submission",
    "arr submission": "direct_submission",
    "paper submission (arr)": "direct_submission",
    "direct submission": "direct_submission",
    "full paper": "full_paper",
    "paper deadline": "full_paper",
    "commitment": "commitment",
    "arr commitment": "commitment",
    "rebuttal ends": "rebuttal",
    "camera-ready": "camera_ready",
    "camera ready": "camera_ready",
}


def milestone_of(deadline_label: str, submission_type: str = "") -> str:
    """Which sub-deadline a row is, or "" when its label is not one we know."""
    key = (deadline_label or "").strip().lower()
    if key in _MILESTONE_FROM_LABEL:
        return _MILESTONE_FROM_LABEL[key]
    # ARR rows carry the answer on their route when the label is uninformative.
    if submission_type == SUBMISSION_COMMITMENT:
        return "commitment"
    if submission_type == SUBMISSION_DIRECT:
        return "direct_submission"
    return ""


def milestone_order(milestone: str) -> int:
    """Sort key: the order a paper meets these, unknowns last."""
    return MILESTONES.index(milestone) if milestone in MILESTONES else len(MILESTONES)


# ACL Rolling Review offers two routes to the same venue, and a paper's history
# decides which one is open to it. Kept as an explicit field rather than inferred
# from the label so the board can say which is which without parsing prose.
SUBMISSION_DIRECT = "direct"          # submit fresh to the ARR cycle
SUBMISSION_COMMITMENT = "commitment"  # commit an already-reviewed ARR paper


def urgency_marker(days_remaining: int) -> str:
    for limit, marker in URGENCY_BANDS:
        if days_remaining <= limit:
            return marker
    return URGENCY_DEFAULT


class AoEClock:
    """Deadline arithmetic in Anywhere-on-Earth (UTC-12).

    A venue's `deadline_aoe` is a wall-clock stamp in AoE, so the real instant
    it expires is twelve hours later in UTC. Everything downstream (days
    remaining, cadence firing, digest windows) has to agree on that conversion,
    which is why it lives here rather than in each script.
    """

    def __init__(self, today: datetime.date) -> None:
        self.today = today
        # Anchor "now" at noon UTC so a whole-day comparison never lands on a
        # boundary that makes days-remaining flicker by one.
        self.now = datetime.datetime(today.year, today.month, today.day, 12, tzinfo=datetime.timezone.utc)

    @classmethod
    def resolve(cls, explicit: str | None = None) -> "AoEClock":
        """Honour --now, then ADMINBOT_DEADLINE_NOW, then the real date."""
        stamp = explicit or os.environ.get("ADMINBOT_DEADLINE_NOW") or datetime.date.today().isoformat()
        return cls(datetime.date.fromisoformat(stamp))

    @staticmethod
    def instant(deadline_aoe: str) -> datetime.datetime:
        parsed = datetime.datetime.strptime(deadline_aoe, "%Y-%m-%d %H:%M:%S")
        return parsed.replace(tzinfo=datetime.timezone.utc) + datetime.timedelta(hours=12)

    @staticmethod
    def calendar_date(deadline_aoe: str) -> datetime.date:
        """The AoE date as printed on the CFP.

        Never derive a user-facing date from `instant()`: that is twelve hours
        later and lands on the following day for the 23:59:59 stamps every venue
        uses, so authors get told a deadline one day after the real one.
        """
        return datetime.date.fromisoformat(deadline_aoe[:10])

    @classmethod
    def calendar_label(cls, deadline_aoe: str) -> str:
        """The AoE calendar date, e.g. "Aug 29" — not the +12h UTC instant."""
        date = cls.calendar_date(deadline_aoe)
        return f"{_MONTHS[date.month]} {date.day}"

    def days_until(self, deadline_aoe: str) -> int:
        return (self.instant(deadline_aoe) - self.now).days

    def has_passed(self, deadline_aoe: str) -> bool:
        return self.now > self.instant(deadline_aoe)

    def is_cadence_day(self, deadline_aoe: str, days_before: int) -> bool:
        """True when today is exactly `days_before` days ahead of the deadline."""
        target = self.instant(deadline_aoe) - datetime.timedelta(days=days_before)
        return target.date() == self.today


class DeadlineDataset:
    """Reader for the generated deadline files under extensions/adminbot/content/deadlines.

    venues.json is generated by adminbot-deadline-collect.py; matches.json by
    adminbot-deadline-match.py and deliberately not committed.
    """

    def __init__(self, directory: str | None = None) -> None:
        self.directory = directory or DEADLINES_DIR

    def _read(self, name: str):
        with open(os.path.join(self.directory, name), encoding="utf-8") as handle:
            return json.load(handle)

    def venues(self) -> list[dict]:
        return self._read("venues.json")["items"]

    def templates(self) -> dict:
        return self._read("dm-templates.json")

    def matches(self) -> dict:
        return self._read("matches.json")

    def upcoming(self, clock: AoEClock, window_days: int) -> list[dict]:
        """Venues whose deadline falls between now and the horizon, soonest first."""
        horizon = clock.now + datetime.timedelta(days=window_days)
        chosen = [
            venue for venue in self.venues() if clock.now <= clock.instant(venue["deadline_aoe"]) <= horizon
        ]
        chosen.sort(key=lambda venue: (venue["deadline_aoe"], venue["name"]))
        return chosen


class SlackNotifier:
    """Sends AdminBot messages through the OpenClaw CLI.

    Dry-run is the default on purpose: these scripts run on cron against real
    people, so delivery has to be opted into explicitly with --send.
    """

    def __init__(self, send: bool = False, cli: str | None = None, runner=subprocess.run) -> None:
        self.send_enabled = send
        self.cli = cli or os.environ.get("OPENCLAW_CLI") or os.path.join(REPO_ROOT, "openclaw.mjs")
        self.runner = runner
        self.delivered = 0

    def send(self, target: str, message: str) -> bool:
        """Deliver to a Slack target ("#channel" or "user:U123"). False when dry-run."""
        if not self.send_enabled:
            print(f"    [dry-run] would send to {target}:\n      " + message.replace("\n", "\n      "))
            return False
        self.runner(
            ["node", self.cli, "message", "send", "--channel", "slack",
             "--target", target, "--message", message, "--json"],
            check=False,
        )
        self.delivered += 1
        return True

    def send_to_user(self, slack_user_id: str, message: str) -> bool:
        return self.send("user:" + slack_user_id, message)

    @property
    def mode(self) -> str:
        return "SEND" if self.send_enabled else "dry-run"
