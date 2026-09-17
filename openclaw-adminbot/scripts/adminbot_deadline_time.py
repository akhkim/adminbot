"""Deadline instants and conservative planning bounds; never infer a closing time.

Exact legacy stamps are normalized AoE wall times. Their timezone is a
representation zone, not a claim about the original source wording.
"""

import datetime

UTC = datetime.timezone.utc
AOE = datetime.timezone(datetime.timedelta(hours=-12))
EARLIEST_ZONE = datetime.timezone(datetime.timedelta(hours=14))
TIME_FIELDS = ("deadline_at", "deadline_date", "deadline_timezone", "deadline_time_precision",
               "deadline_planning_at")


def timing_fields(stamp, *, date_only=False, timezone=""):
    if not stamp:
        return {key: "" for key in TIME_FIELDS}
    if date_only:
        day = datetime.date.fromisoformat(stamp[:10])
        # With an unknown zone, UTC+14 is the first place this calendar day begins.
        zone = AOE if timezone == "AoE" else UTC if timezone == "UTC" else EARLIEST_ZONE
        instant = datetime.datetime.combine(day, datetime.time(), zone).astimezone(UTC)
        exact = ""
    else:
        instant = datetime.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S").replace(tzinfo=AOE).astimezone(UTC)
        exact = instant.isoformat().replace("+00:00", "Z")
    planning = instant.isoformat().replace("+00:00", "Z")
    return dict(deadline_at=exact, deadline_date=stamp[:10],
                deadline_timezone=timezone if date_only else "AoE",
                deadline_time_precision="date_only" if date_only else "exact",
                deadline_planning_at=planning,
                deadline_aoe=instant.astimezone(AOE).strftime("%Y-%m-%d %H:%M:%S"))


def deadline_label(item):
    if item.get("deadline_time_precision") == "date_only":
        zone = item.get("deadline_timezone") or "timezone unknown"
        return f"{item['deadline_date']} ({zone}; time unknown; plan before {item['deadline_planning_at']})"
    return f"{item['deadline_aoe']} AoE"
