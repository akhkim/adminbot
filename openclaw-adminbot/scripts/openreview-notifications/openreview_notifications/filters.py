"""Select by date and conference, then verify the selected venues agree."""
import math
import re
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

from .messages import subject_header

GENERIC_DOMAINS = {"openreview.net", "openreview.net/support"}
VENUE_FIELDS = ("domain", "invitation", "signature", "referrer")
SENDER_FIELDS = ("fromEmail", "from", "fromName", "fromname")


def conference_from_path(value):
    """Read the conference before the year, never a workshop name after it."""
    if not isinstance(value, str):
        return None
    if value.startswith(("https://", "http://")):
        try:
            url = urlsplit(value)
            if url.hostname not in {"openreview.net", "www.openreview.net"}:
                return None
            value = parse_qs(url.query).get("id", [""])[0]
        except ValueError:
            return None
    parts = value.strip().strip("/").split("/")
    for index, part in enumerate(parts):
        if index and re.fullmatch(r"\d{4}", part):
            return parts[index - 1].split(".")[0]
    return None


def has_specific_domain(record):
    domain = record.get("domain")
    if not isinstance(domain, str) or not domain.strip():
        return False
    return domain.strip().rstrip("/").casefold() not in GENERIC_DOMAINS


def venue_evidence(record):
    """Collect each independently readable structured venue field."""
    evidence = {}
    for field in VENUE_FIELDS:
        venue = conference_from_path(record.get(field))
        if venue:
            evidence[field] = venue
    return evidence


def matches_conference(record, conference):
    """Prefer domain, then structured metadata, then sender/subject hints."""
    name_pattern = re.compile(
        r"(?<![a-z0-9])" + re.escape(conference.strip()) + r"(?![a-z])", re.I,
    )

    def mentions_conference(value):
        return isinstance(value, str) and name_pattern.search(value) is not None

    if has_specific_domain(record):
        domain = record["domain"]
        venue = conference_from_path(domain) or domain.split("/")[0]
        return mentions_conference(venue)

    venues = {venue.casefold() for venue in venue_evidence(record).values()}
    if venues:
        return len(venues) == 1 and mentions_conference(next(iter(venues)))

    content = record.get("content")
    if not isinstance(content, dict):
        return False
    subject = content.get("subject", "")
    if isinstance(subject, str) and mentions_conference(subject_header(subject)):
        return True
    return any(mentions_conference(content.get(field)) for field in SENDER_FIELDS)


def parse_min_date(value):
    """A plain date is midnight UTC; a timestamp must include its timezone."""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            date = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        else:
            date = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if date.tzinfo is None:
                raise ValueError("Timezone required")
        return date.timestamp() * 1000
    except (ValueError, OverflowError) as exc:
        raise ValueError("min_date must be YYYY-MM-DD or an ISO timestamp with timezone") from exc


def is_valid_timestamp(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def filter_notifications(data, cutoff_ms, conference):
    """Preserve original records and order; the date boundary is exclusive."""
    if not isinstance(data, list):
        raise ValueError("Expected a top-level JSON array of notification objects")
    if not isinstance(conference, str) or not conference.strip():
        raise ValueError("Conference name must not be empty")
    selected = []
    for index, record in enumerate(data, 1):
        if not isinstance(record, dict):
            raise ValueError(f"Record {index}: notification must be an object")
        if not is_valid_timestamp(record.get("cdate")):
            raise ValueError(f"Record {index}: cdate must be a finite Unix timestamp in milliseconds")
        if record["cdate"] > cutoff_ms and matches_conference(record, conference):
            selected.append(record)
    return selected


def venue_problem(record, conference):
    """The final check is stricter: all structured evidence must agree."""
    evidence = venue_evidence(record)
    if has_specific_domain(record) and "domain" not in evidence:
        return "cannot verify the domain's conference"
    if not evidence:
        return "no structured venue evidence"

    requested = conference.strip().casefold()
    for venue in evidence.values():
        name = venue.casefold()
        # Allow either component of a joint conference, e.g. AACL-IJCNLP.
        if requested != name and requested not in name.split("-"):
            found = ", ".join(f"{field}={value}" for field, value in evidence.items())
            return f"expected {conference}; found {found}"
    return None


def validate_selected_venues(records, conference):
    """Fail the batch before output; years and tracks may differ."""
    problems = []
    for index, record in enumerate(records, 1):
        problem = venue_problem(record, conference)
        if problem:
            problems.append(f"Record {index} ({record.get('id', 'no id')}): {problem}")
    if problems:
        raise ValueError("Final venue check failed; no output written.\n" + "\n".join(problems))
