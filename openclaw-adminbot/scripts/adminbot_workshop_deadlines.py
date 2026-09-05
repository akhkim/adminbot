#!/usr/bin/env python3
"""Pure, deterministic extraction of workshop submission deadlines.

The collector supplies first-party HTML (and, when needed, a page's own script
assets) plus the exact OpenReview cutoff.  This module contains no workshop
identifiers or curated dates: it finds labelled paper-submission dates, separates
abstract registration from the final manuscript deadline, and reports enough
evidence for the generated dataset to remain auditable.
"""

from __future__ import annotations

import datetime
import html as html_module
import re
from html.parser import HTMLParser


MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
MONTH_PATTERN = "|".join(sorted(MONTHS, key=len, reverse=True))
DATE_PATTERNS = (
    re.compile(
        rf"(?i)\b(?P<month>{MONTH_PATTERN})\.?\s+"
        rf"(?P<day>\d{{1,2}})(?:st|nd|rd|th)?(?:\s*,)?\s*(?P<year>20\d{{2}})?\b"
    ),
    re.compile(
        rf"(?i)\b(?P<day>\d{{1,2}})(?:st|nd|rd|th)?(?:\s+of)?\s+"
        rf"(?P<month>{MONTH_PATTERN})\.?(?:\s*,)?\s*(?P<year>20\d{{2}})?\b"
    ),
    re.compile(r"\b(?P<year>20\d{2})[-/](?P<month_num>\d{2})[-/](?P<day>\d{2})\b"),
)

POSITIVE_SIGNALS = (
    (re.compile(r"(?i)\bfull\s+(?:paper|manuscript)\s+(?:submission\s+)?deadline\b"), 280),
    (re.compile(r"(?i)\bpaper\s+submission\s+deadline\b"), 265),
    (re.compile(r"(?i)\b(?:final|regular)\s+submission\s+deadline\b"), 260),
    (re.compile(r"(?i)\bsubmission\s+deadline\b"), 245),
    (re.compile(r"(?i)\bdeadline\s+for\s+(?:the\s+)?submission(?:\s+of\s+papers)?\b"), 240),
    (re.compile(r"(?i)\b(?:papers?|submissions?)\s+(?:are\s+)?(?:now\s+)?due\b"), 230),
    (re.compile(r"(?i)\b(?:paper|submission)\s+deadline\b"), 225),
    (re.compile(r"(?i)\bworkshop\s+paper\s+submission\b"), 220),
    (re.compile(r"(?i)\b(?:fast[ -]?track|competition)\s+deadline\b"), 215),
    (re.compile(r"(?i)\barchival\s+paper\b"), 190),
)
NEGATIVE_SIGNALS = (
    (re.compile(r"(?i)\b(?:abstract|intent)\s+(?:registration|submission|due|deadline)\b"), 330),
    (re.compile(r"(?i)\b(?:paper\s+)?submission\s+(?:opens?|opening)\b"), 340),
    (re.compile(r"(?i)\b(?:author|acceptance|decision)\s+notification\b"), 330),
    (re.compile(r"(?i)\bnotification\s+(?:of\s+acceptance|deadline|date|sent)\b"), 330),
    (re.compile(r"(?i)\bcamera[ -]?ready\b"), 330),
    (re.compile(r"(?i)\b(?:review|reviewer|meta-review)\s+(?:period|deadline|due|application)\b"), 315),
    (re.compile(r"(?i)\bsubmission\s+(?:portal|site|window)\s+(?:opens?|opening)\b"), 315),
    (re.compile(r"(?i)\bworkshop\s+(?:date|day)\b"), 330),
)
EXTENSION_SIGNAL = re.compile(
    r"(?i)(?:"
    r"\bdeadline\b.{0,90}\b(?:extend(?:ed|s|ing|ion)?|previously|original(?:ly)?|was)\b|"
    r"\b(?:deadline\s+)?extend(?:ed|s|ing|ion)?\s+(?:to|until|by|from)\b|"
    r"\b(?:deadline\s+(?:has\s+been\s+)?extended|new\s+deadline|deadline\s+is\s+now)\b"
    r")"
)
OLD_HINT_LEFT = re.compile(
    r"(?i)(?:\bwas\s*[:=]?\s*[\"'`]*|\bprevious(?:ly)?\s*[:=]?\s*[\"'`]*|"
    r"\boriginal(?:\s+deadline)?\s*[:=]?\s*[\"'`]*|\bextended\s+from\s*)$"
)
OLD_HINT_RIGHT = re.compile(r"(?i)^\s*(?:\)?\s*)?(?:extended\s+(?:to|until)|→|--?>)")
GLOBAL_DEADLINE_TIME = re.compile(
    r"(?i)all\s+(?:dates|deadlines)[^.;]{0,80}?"
    r"(?P<hour>[01]?\d|2[0-3]):(?P<minute>\d{2})\s*"
    r"(?P<ampm>a\.?m\.?|p\.?m\.?)?.{0,100}?(?:AoE|Anywhere\s+on\s+Earth)"
)
LOCAL_TIME = re.compile(
    r"(?i)(?<!\d)(?P<hour>[01]?\d|2[0-3]):(?P<minute>\d{2})\s*"
    r"(?P<ampm>a\.?m\.?|p\.?m\.?)?\s*"
    r"(?P<zone>AoE|Anywhere\s+on\s+Earth|UTC(?:[+-]0)?|GMT)"
)
LOCAL_HOUR_TIME = re.compile(
    r"(?i)(?<!\d)(?P<hour>[01]?\d|2[0-3])\s*"
    r"(?P<ampm>a\.?m\.?|p\.?m\.?)\s*"
    r"(?P<zone>AoE|Anywhere\s+on\s+Earth|UTC(?:[+-]0)?|GMT)"
)
BLOCK_TAGS = {
    "article", "br", "dd", "div", "dl", "dt", "figcaption", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "p",
    "section", "td", "th", "tr",
}
TRACK_HINT_WORDS = {
    "abstract", "archival", "arr", "commitment", "competition", "demo", "demonstration",
    "direct", "fast", "findings", "nonarchival", "position", "proceedings", "shared",
    "track",
}


def _nested_value(content, key):
    value = (content or {}).get(key)
    return value.get("value") if isinstance(value, dict) else value


def group_final_submission_deadline(content):
    """An explicit final-paper stamp from an OpenReview group workflow summary."""
    summary = str(_nested_value(content, "date") or "")
    if not re.search(r"(?i)Abstract\s+Registration\s*:", summary):
        return ""
    match = re.search(
        r"(?i)Submission\s+Deadline\s*:\s*"
        r"([A-Z][a-z]{2}\s+\d{1,2}\s+20\d{2}\s+\d{1,2}:\d{2}(?:AM|PM)\s+UTC-0)",
        summary,
    )
    if not match:
        return ""
    try:
        utc = datetime.datetime.strptime(match.group(1), "%b %d %Y %I:%M%p UTC-0")
    except ValueError:
        return ""
    return (utc - datetime.timedelta(hours=12)).strftime("%Y-%m-%d %H:%M:%S")


class _DeadlineHTMLParser(HTMLParser):
    """Extract visible and inline-script text while retaining crossed-out dates."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.visible = []
        self.scripts = []
        self.script_urls = []
        self._hidden_depth = 0
        self._script_depth = 0
        self._old_stack = []

    @staticmethod
    def _is_old(tag, attrs):
        attributes = dict(attrs)
        classes = attributes.get("class", "")
        style = attributes.get("style", "")
        return tag in {"del", "s", "strike"} or bool(
            re.search(r"(?i)(?:line-through|strikethrough|old-date|previous-date)", f"{classes} {style}")
        )

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            source = dict(attrs).get("src")
            if source:
                self.script_urls.append(source)
            self._script_depth += 1
            return
        if tag in {"style", "noscript", "svg", "template"}:
            self._hidden_depth += 1
            return
        is_old = self._is_old(tag, attrs)
        self._old_stack.append((tag, is_old))
        if is_old and not self._hidden_depth:
            self.visible.append(" [OLD] ")
        if tag in BLOCK_TAGS and not self._hidden_depth:
            self.visible.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag == "script":
            source = dict(attrs).get("src")
            if source:
                self.script_urls.append(source)
        elif tag in BLOCK_TAGS and not self._hidden_depth:
            self.visible.append("\n")

    def handle_data(self, data):
        if self._script_depth:
            self.scripts.append(data)
        elif not self._hidden_depth:
            self.visible.append(data)

    def handle_endtag(self, tag):
        if tag == "script":
            if self._script_depth:
                self._script_depth -= 1
            return
        if tag in {"style", "noscript", "svg", "template"}:
            if self._hidden_depth:
                self._hidden_depth -= 1
            return
        is_old = False
        for index in range(len(self._old_stack) - 1, -1, -1):
            if self._old_stack[index][0] == tag:
                _, is_old = self._old_stack.pop(index)
                break
        if is_old and not self._hidden_depth:
            self.visible.append(" [/OLD] ")
        if tag in BLOCK_TAGS and not self._hidden_depth:
            self.visible.append("\n")


def deadline_texts_from_html(html):
    parser = _DeadlineHTMLParser()
    parser.feed(html or "")
    texts = [("visible", "".join(parser.visible))]
    inline_script = "\n".join(parser.scripts)
    if inline_script.strip():
        texts.append(("inline-script", inline_script))
    return texts, parser.script_urls


def _normalize_text(text):
    return re.sub(r"\s+", " ", html_module.unescape(text or "").replace("\u00a0", " ")).strip()


def _parse_date(match, year):
    groups = match.groupdict()
    month = int(groups["month_num"]) if groups.get("month_num") else MONTHS[groups["month"].lower()]
    try:
        return datetime.date(int(groups.get("year") or year), month, int(groups["day"]))
    except ValueError:
        return None


def _all_dates(text, year):
    found = []
    occupied = []
    for pattern in DATE_PATTERNS:
        for match in pattern.finditer(text):
            if any(start < match.end() and match.start() < end for start, end in occupied):
                continue
            date = _parse_date(match, year)
            if date and date.year == year:
                found.append((match.start(), match.end(), date))
                occupied.append((match.start(), match.end()))
    return sorted(found)


def _twelve_hour(hour, ampm):
    if not ampm:
        return hour
    return (hour % 12) + (12 if ampm.lower().startswith("p") else 0)


def _global_aoe_time(text):
    match = GLOBAL_DEADLINE_TIME.search(text)
    if not match:
        return None
    return _twelve_hour(int(match.group("hour")), match.group("ampm")), int(match.group("minute"))


def _candidate_stamp(text, start, end, date):
    nearby_start = max(0, start - 90)
    nearby_end = min(len(text), end + 120)
    nearby = text[nearby_start:nearby_end]
    # A parenthesized alternate such as ``Sep 15 AoE`` often follows
    # ``September 16, 11:59 UTC``.  The AoE token belongs to this date; reusing
    # the preceding UTC clock would subtract twelve hours twice.
    immediate = text[max(0, start - 20):min(len(text), end + 35)]
    if re.search(r"(?i)(?:AoE|Anywhere\s+on\s+Earth)", immediate) and not (
        LOCAL_TIME.search(immediate) or LOCAL_HOUR_TIME.search(immediate)
    ):
        return datetime.datetime.combine(date, datetime.time(23, 59)).strftime(
            "%Y-%m-%d %H:%M:%S"
        ), "aoe-date"
    local_matches = list(LOCAL_TIME.finditer(nearby)) + list(LOCAL_HOUR_TIME.finditer(nearby))
    local = min(
        local_matches,
        key=lambda match: min(
            abs((nearby_start + match.start()) - start),
            abs((nearby_start + match.end()) - end),
        ),
        default=None,
    )
    if local:
        hour = _twelve_hour(int(local.group("hour")), local.group("ampm"))
        minute = int(local.groupdict().get("minute") or 0)
        moment = datetime.datetime.combine(date, datetime.time(hour, minute))
        if local.group("zone").lower().startswith(("utc", "gmt")):
            moment -= datetime.timedelta(hours=12)
        return moment.strftime("%Y-%m-%d %H:%M:%S"), "explicit"
    default = _global_aoe_time(text)
    if default:
        return datetime.datetime.combine(date, datetime.time(*default)).strftime("%Y-%m-%d %H:%M:%S"), "global"
    if re.search(r"(?i)(?:AoE|Anywhere\s+on\s+Earth)", nearby):
        return datetime.datetime.combine(date, datetime.time(23, 59)).strftime("%Y-%m-%d %H:%M:%S"), "aoe-date"
    return date.isoformat(), "date-only"


def _nearest_signal(text, start, end, patterns):
    center = (start + end) // 2
    best = (0, "", 10_000)
    for pattern, weight in patterns:
        for match in pattern.finditer(text, max(0, start - 210), min(len(text), end + 210)):
            distance = min(abs(center - match.start()), abs(center - match.end()))
            score = max(0, weight - distance)
            if score > best[0]:
                best = (score, match.group(0), distance)
    return best


def _nearest_match_distance(text, start, end, pattern, radius=220):
    center = (start + end) // 2
    distances = [
        min(abs(center - match.start()), abs(center - match.end()))
        for match in pattern.finditer(text, max(0, start - radius), min(len(text), end + radius))
    ]
    return min(distances, default=10_000)


def _inside_old_marker(text, start, end):
    opened = text.rfind("[OLD]", 0, start)
    closed = text.rfind("[/OLD]", 0, start)
    return opened > closed and text.find("[/OLD]", end) >= 0


def _old_hint(text, start, end):
    if _inside_old_marker(text, start, end):
        return True
    left = text[max(0, start - 70):start]
    right = text[end:min(len(text), end + 70)]
    return bool(OLD_HINT_LEFT.search(left) or OLD_HINT_RIGHT.search(right))


def deadline_candidates_from_text(
    text, source_url, year, document_id="", positive_signals=POSITIVE_SIGNALS
):
    """
    Dates on a page that a signal phrase says are deadlines, with the evidence they were read from.

    `positive_signals` is a parameter because the phrases are the only subject-specific part of
    this. The default set is about papers -- "submission deadline", "papers are due" -- and finds
    nothing on a fellowship page, which talks about applications. The opportunity sweep passes its
    own vocabulary rather than adding application words here, because a CFP page that happens to
    mention an application deadline must not have it outrank the paper deadline for the 143
    workshops this default set is tuned for.
    """
    normalized = _normalize_text(text)
    output = []
    for start, end, date in _all_dates(normalized, year):
        positive, label, positive_distance = _nearest_signal(
            normalized, start, end, positive_signals
        )
        negative, negative_label, negative_distance = _nearest_signal(
            normalized, start, end, NEGATIVE_SIGNALS
        )
        if not positive:
            continue
        score = positive - (negative if negative_distance <= positive_distance + 15 else negative // 3)
        evidence_start = max(0, start - 260)
        evidence_end = min(len(normalized), end + 360)
        evidence = normalized[evidence_start:evidence_end]
        # Route/stage labels normally precede their value. Keep this deliberately
        # left-heavy so the next row's label cannot classify the current date.
        context = normalized[max(0, start - 100):min(len(normalized), end + 20)]
        stamp, precision = _candidate_stamp(normalized, start, end, date)
        extension_distance = _nearest_match_distance(
            normalized, start, end, EXTENSION_SIGNAL
        )
        output.append(
            {
                "stamp": stamp,
                "date": date.isoformat(),
                "effective_date": stamp[:10],
                "precision": precision,
                "score": score,
                "label": label,
                "positive_distance": positive_distance,
                "negative": negative_label,
                "negative_distance": negative_distance,
                "extended": extension_distance <= 60,
                "extension_distance": extension_distance,
                "old_hint": _old_hint(normalized, start, end),
                "evidence": evidence.replace("[OLD]", "").replace("[/OLD]", "").strip()[:700],
                "context": context.replace("[OLD]", "").replace("[/OLD]", "").strip(),
                "source_url": source_url,
                "document_id": document_id or source_url,
                "position": start,
            }
        )
    return output


def deadline_candidates_from_html(html, source_url, year, positive_signals=POSITIVE_SIGNALS):
    texts, script_urls = deadline_texts_from_html(html)
    candidates = []
    for kind, text in texts:
        candidates.extend(
            deadline_candidates_from_text(
                text, source_url, year, f"{source_url}#{kind}", positive_signals
            )
        )
    return candidates, script_urls


def _candidate_date(candidate):
    return datetime.date.fromisoformat(candidate["effective_date"])


def _candidate_is_abstract(candidate):
    return bool(
        re.search(r"(?i)\babstract\b", candidate["negative"])
        and (
            candidate["negative_distance"] <= candidate["positive_distance"] + 15
            or candidate["extension_distance"] <= 60
        )
    )


def _deduplicate_candidates(candidates):
    best = {}
    for candidate in candidates:
        key = (
            candidate["stamp"],
            candidate["source_url"],
            _candidate_is_abstract(candidate),
            candidate["extended"],
        )
        previous = best.get(key)
        if previous is None or candidate["score"] > previous["score"]:
            candidate = dict(candidate)
            candidate["occurrences"] = (previous or {}).get("occurrences", 0) + 1
            best[key] = candidate
        else:
            previous["occurrences"] += 1
    return list(best.values())


def _target_track_tokens(target_hint):
    return {
        token
        for token in re.findall(r"[a-z]+", (target_hint or "").lower().replace("non-archival", "nonarchival"))
        if token in TRACK_HINT_WORDS
    }


def _track_relevance(candidate, target_hint):
    tokens = _target_track_tokens(target_hint)
    if not tokens:
        return 0
    evidence = candidate.get("context", candidate["evidence"]).lower().replace(
        "non-archival", "nonarchival"
    )
    label = candidate["label"].lower().replace("non-archival", "nonarchival")
    return 4 * sum(token in label for token in tokens) + sum(token in evidence for token in tokens)


def select_official_candidate(candidates, fallback_stamp, year, target_hint=""):
    candidates = _deduplicate_candidates(candidates)
    for candidate in candidates:
        candidate["track_relevance"] = _track_relevance(candidate, target_hint)
    fallback_date = (
        datetime.date.fromisoformat(fallback_stamp[:10])
        if re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", fallback_stamp or "")
        else None
    )
    anchor_dates = {fallback_date.isoformat()} if fallback_date else set()
    if fallback_date and fallback_stamp[11:19] == "00:00:00":
        anchor_dates.add((fallback_date - datetime.timedelta(days=1)).isoformat())
    ranked = sorted(
        candidates,
        key=lambda candidate: (
            candidate["effective_date"] in anchor_dates,
            candidate["track_relevance"],
            "abstract" in target_hint.lower() or not _candidate_is_abstract(candidate),
            not candidate["old_hint"],
            candidate["precision"] != "date-only",
            candidate["score"],
            candidate.get("occurrences", 1),
        ),
        reverse=True,
    )
    if not ranked:
        return None, ranked
    target_track_tokens = _target_track_tokens(target_hint)
    max_track_relevance = max(candidate["track_relevance"] for candidate in ranked)
    if target_track_tokens and not max_track_relevance:
        return None, ranked
    route_ranked = (
        [candidate for candidate in ranked if candidate["track_relevance"] == max_track_relevance]
        if max_track_relevance
        else ranked
    )
    if not fallback_date:
        strong = [candidate for candidate in route_ranked if candidate["score"] >= -100]
        return (strong[0] if strong else None), ranked

    exact = [candidate for candidate in route_ranked if candidate["effective_date"] in anchor_dates]
    later_final = [
        candidate
        for candidate in route_ranked
        if 0 < (_candidate_date(candidate) - fallback_date).days <= 21
        and candidate["score"] >= 120
        and candidate["precision"] != "date-only"
        and not _candidate_is_abstract(candidate)
    ]
    if exact and _candidate_is_abstract(exact[0]) and later_final:
        return max(later_final, key=lambda candidate: candidate["score"]), ranked

    adjacent = [
        candidate
        for candidate in route_ranked
        if abs((_candidate_date(candidate) - fallback_date).days) == 1
    ]
    if exact and exact[0]["score"] < 0 and adjacent:
        best_adjacent = max(
            adjacent,
            key=lambda candidate: (
                candidate["score"],
                candidate["precision"] != "date-only",
                candidate.get("occurrences", 1),
            ),
        )
        if best_adjacent["score"] > exact[0]["score"] + 30:
            return best_adjacent, ranked
    if exact and exact[0]["score"] > -160:
        return exact[0], ranked
    if adjacent:
        return max(
            adjacent,
            key=lambda candidate: (
                candidate["precision"] != "date-only",
                candidate["score"],
                candidate.get("occurrences", 1),
            ),
        ), ranked

    if max_track_relevance:
        strong_route = [candidate for candidate in route_ranked if candidate["score"] >= -100]
        if strong_route:
            return strong_route[0], ranked

    strong = [
        candidate
        for candidate in route_ranked
        if candidate["score"] >= 120
        and not _candidate_is_abstract(candidate)
        and (
            candidate["extended"]
            or re.search(r"(?i)\b(?:full\s+(?:paper|manuscript)|paper\s+submission)\b", candidate["label"])
        )
    ]
    return (strong[0] if strong else None), ranked


def _as_full_stamp(candidate, current_stamp):
    if len(candidate["stamp"]) > 10:
        return candidate["stamp"]
    return f"{candidate['date']} {current_stamp[11:19]}"


def extension_revision_stamps(selected, candidates, target_hint=""):
    """Return only source-explicit old dates followed by the selected current date."""
    if not selected or len(selected["stamp"]) == 10:
        return []
    current = selected["stamp"]
    selected_track_relevance = _track_relevance(selected, target_hint)
    old = []
    for candidate in candidates:
        if (
            candidate["source_url"] != selected["source_url"]
            or candidate["document_id"] != selected["document_id"]
            or abs(candidate["position"] - selected["position"]) > 450
            or not candidate["old_hint"]
        ):
            continue
        if candidate["negative"] and candidate["negative_distance"] <= candidate["positive_distance"] + 15:
            continue
        if _candidate_is_abstract(candidate) and not _candidate_is_abstract(selected):
            continue
        if (
            selected_track_relevance
            and _track_relevance(candidate, target_hint) != selected_track_relevance
        ):
            continue
        stamp = _as_full_stamp(candidate, current)
        if stamp[:16] < current[:16]:
            old.append(stamp)

    evidence = selected["evidence"]
    duration = re.search(r"(?i)extended\s+by\s+(?P<count>one|\d+)\s+week", evidence)
    if not old and selected["extended"] and duration:
        count = 1 if duration.group("count").lower() == "one" else int(duration.group("count"))
        previous = datetime.datetime.strptime(current, "%Y-%m-%d %H:%M:%S") - datetime.timedelta(
            days=7 * count
        )
        old.append(previous.strftime("%Y-%m-%d %H:%M:%S"))

    chain = sorted(dict.fromkeys(old + [current]))
    return chain if len(chain) > 1 and chain[-1][:16] == current[:16] else []


def reconcile_deadline_candidates(
    candidates,
    openreview_stamp,
    openreview_url,
    year,
    group_final_stamp="",
    group_final_evidence="",
    target_hint="",
):
    """Select one deadline while preserving source conflicts and extension evidence."""
    fallback = group_final_stamp or openreview_stamp
    fallback_kind = "openreview_group" if group_final_stamp else "openreview"
    selected, ranked = select_official_candidate(candidates, fallback, year, target_hint)
    if selected and not selected["extended"]:
        equivalent_extensions = [
            candidate
            for candidate in candidates
            if candidate["stamp"][:16] == selected["stamp"][:16]
            and candidate["source_url"] == selected["source_url"]
            and candidate["extended"]
            and (
                "abstract" in target_hint.lower()
                or not _candidate_is_abstract(candidate)
            )
        ]
        if equivalent_extensions:
            selected = max(equivalent_extensions, key=lambda candidate: candidate["score"])
    result = {
        "deadline_aoe": fallback,
        "source_url": openreview_url,
        "deadline_source_kind": fallback_kind if fallback else "unobserved",
        "deadline_source_status": "openreview_only" if fallback else "unobserved",
        "deadline_source_precision": "exact",
        "deadline_source_evidence": group_final_evidence if group_final_stamp else "",
        "deadline_official_url": "",
        "deadline_official_evidence": "",
        "deadline_extended": False,
        "source_revisions": [],
        "alternatives": ranked,
    }
    if group_final_stamp:
        result["deadline_source_status"] = "openreview_final_submission"
    if not selected:
        return result

    result["deadline_official_url"] = selected["source_url"]
    result["deadline_official_evidence"] = selected["evidence"]
    result["deadline_extended"] = bool(selected["extended"])
    if len(selected["stamp"]) == 10:
        if fallback and selected["effective_date"] == fallback[:10]:
            selected_with_time = dict(selected, stamp=fallback)
            result["source_revisions"] = extension_revision_stamps(
                selected_with_time, candidates, target_hint
            )
            result["deadline_extended"] = bool(
                result["deadline_extended"] or len(result["source_revisions"]) > 1
            )
        result["deadline_source_status"] = (
            "official_date_matches_openreview"
            if fallback and selected["effective_date"] == fallback[:10]
            else "official_date_conflicts_with_openreview"
        )
        result["deadline_source_precision"] = "date_only"
        return result

    official = selected["stamp"]
    if fallback:
        official_instant = datetime.datetime.strptime(official, "%Y-%m-%d %H:%M:%S")
        fallback_instant = datetime.datetime.strptime(fallback, "%Y-%m-%d %H:%M:%S")
        delta = official_instant - fallback_instant
        # OpenReview is the operational cutoff and is retained when it is
        # materially later than an otherwise unmarked website date.  A labelled
        # final-paper date, a source-explicit extension, a later official date,
        # or sub-two-hour portal clock drift is resolved to the advertised CFP
        # value instead.  Every disagreement remains recorded in the status.
        use_official = (
            delta >= datetime.timedelta(0)
            or abs(delta) <= datetime.timedelta(hours=2)
            or selected["extended"]
            or bool(group_final_stamp and official[:16] == group_final_stamp[:16])
        )
        if not use_official:
            result["deadline_source_status"] = "openreview_later_than_official"
            result["deadline_source_precision"] = selected["precision"]
            result["source_revisions"] = extension_revision_stamps(
                selected, candidates, target_hint
            )
            result["deadline_extended"] = bool(
                result["deadline_extended"] or len(result["source_revisions"]) > 1
            )
            return result

    result.update(
        deadline_aoe=official,
        source_url=selected["source_url"],
        deadline_source_kind="official",
        deadline_source_precision=selected["precision"],
        deadline_source_evidence=selected["evidence"],
        deadline_source_status=(
            "official_matches_openreview"
            if fallback and official[:16] == fallback[:16]
            else "official_overrides_openreview"
        ),
    )
    result["source_revisions"] = extension_revision_stamps(selected, candidates, target_hint)
    result["deadline_extended"] = bool(
        result["deadline_extended"] or len(result["source_revisions"]) > 1
    )
    return result
