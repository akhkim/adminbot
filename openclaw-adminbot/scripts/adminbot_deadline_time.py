"""Deadline instants and conservative planning bounds; never infer a closing time.

Exact legacy stamps are normalized AoE wall times. Their timezone is a
representation zone, not a claim about the original source wording.
"""

import datetime
import re
from zoneinfo import ZoneInfo

UTC = datetime.timezone.utc
AOE = datetime.timezone(datetime.timedelta(hours=-12))
EARLIEST_ZONE = datetime.timezone(datetime.timedelta(hours=14))
TIME_FIELDS = ("deadline_at", "deadline_date", "deadline_timezone", "deadline_time_precision")


def planning_instant(date, timezone=""):
    """Start of the source date; unknown zones use the first possible civil day."""
    day = datetime.date.fromisoformat(date)
    fixed = re.fullmatch(r"(?:UTC|GMT)([+-])(\d{1,2})(?::(\d{2}))?", timezone)
    if fixed:
        hours, minutes = int(fixed[2]), int(fixed[3] or 0)
        if hours > 14 or minutes > 59 or (hours == 14 and minutes):
            raise ValueError("Invalid timezone offset")
        offset = (hours * 60 + minutes) * (1 if fixed[1] == "+" else -1)
        zone = datetime.timezone(datetime.timedelta(minutes=offset))
    else:
        zone = AOE if timezone == "AoE" else ZoneInfo(timezone) if timezone else EARLIEST_ZONE
    return datetime.datetime.combine(day, datetime.time(), zone).astimezone(UTC)


def planning_timestamp(item):
    if item.get("deadline_time_precision") == "date_only":
        return planning_instant(item["deadline_date"], item.get("deadline_timezone", "")).isoformat().replace("+00:00", "Z")
    return item["deadline_at"]


def timing_fields(stamp, *, date_only=False, timezone=""):
    if not stamp:
        return {key: "" for key in TIME_FIELDS}
    if date_only:
        instant = planning_instant(stamp[:10], timezone)
        exact = ""
    else:
        instant = datetime.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S").replace(tzinfo=AOE).astimezone(UTC)
        exact = instant.isoformat().replace("+00:00", "Z")
    source_date = instant.date().isoformat() if not date_only and timezone == "UTC" else stamp[:10]
    return dict(deadline_at=exact, deadline_date=source_date,
                deadline_timezone=timezone,
                deadline_time_precision="date_only" if date_only else "exact",
                deadline_aoe=instant.astimezone(AOE).strftime("%Y-%m-%d %H:%M:%S"))


def deadline_label(item):
    if item.get("deadline_time_precision") == "date_only":
        zone = item.get("deadline_timezone") or "timezone unknown"
        return f"{item['deadline_date']} ({zone}; time unknown; plan before {planning_timestamp(item)})"
    return f"{item['deadline_aoe']} AoE"
