"""ACL Rolling Review dates page: every review cycle and every participating venue.

The page publishes two tables. The cycle table lists, per cycle, the submission date, reviewer
registration, reviews due, the author-response window, meta-review release and cycle end. The
venue table lists each commitment venue's final ARR submission date and commitment date. Both are
parsed here with no model call, so a new cycle appears in the dataset as soon as ARR lists it,
and a venue whose own CFP disagrees with ARR's table is flagged instead of silently preferred.
"""
import datetime
import re
from html.parser import HTMLParser

ARR_DATES_URL = "https://aclrollingreview.org/dates"
MONTHS = {name: number for number, name in enumerate(
    ("january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"), 1)}
_DATE = re.compile(r"(?i)\b(" + "|".join(MONTHS) + r")\.?\s+(\d{1,2})(?:\s*,\s*(20\d{2}))?\b")
_MONTH_ONLY = re.compile(r"(?i)^(" + "|".join(MONTHS) + r")\.?\s*,?\s*(20\d{2})$")
CYCLE_COLUMNS = ("submission", "reviewer_registration", "reviews_due", "author_response",
                 "meta_reviews", "cycle_end")


class _Tables(HTMLParser):
    """Rows of every table, as {css class: [[cell text, ...], ...]}, ignoring struck-out text."""

    def __init__(self):
        super().__init__()
        self.tables, self.stack, self.row, self.cell, self.struck = {}, [], None, None, 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.stack.append(dict(attrs).get("class", ""))
            self.tables.setdefault(self.stack[-1], [])
        elif tag in ("s", "del", "strike"):
            self.struck += 1
        elif tag == "tr" and self.stack:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None and not self.struck:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("s", "del", "strike"):
            self.struck = max(0, self.struck - 1)
        elif tag in ("td", "th") and self.cell is not None:
            self.row.append(" ".join(" ".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.tables[self.stack[-1]].append(self.row)
            self.row = None
        elif tag == "table" and self.stack:
            self.stack.pop()


def _rows(html, css_class):
    parser = _Tables()
    parser.feed(html)
    return [row for row in parser.tables.get(css_class, []) if row]


def _dates(text, year, floor=None):
    """Dates in a cell, in order. A date earlier than ``floor`` belongs to the following year."""
    found, current = [], year
    for match in _DATE.finditer(text):
        month, day = MONTHS[match[1].lower()], int(match[2])
        explicit = int(match[3]) if match[3] else None
        if explicit:
            current = explicit
        try:
            date = datetime.date(current, month, day)
        except ValueError:
            continue
        if not explicit and floor and date < floor:
            current += 1
            date = datetime.date(current, month, day)
        found.append(date)
        floor = date
    return found


def parse_arr_cycles(html):
    """One dict per cycle row: id, name, and each milestone as an ISO date (or a window)."""
    cycles = []
    for row in _rows(html, "review-cycle-table"):
        title = _MONTH_ONLY.match(row[0]) if len(row) >= 7 else None
        if not title:
            continue
        month, year = MONTHS[title[1].lower()], int(title[2])
        floor = datetime.date(year, month, 1)
        milestones = {}
        for name, cell in zip(CYCLE_COLUMNS, row[1:7]):
            dates = _dates(cell, floor.year, floor)
            if not dates:
                continue
            floor = dates[-1]
            milestones[name] = dates[0].isoformat() if len(dates) == 1 else {
                "starts": dates[0].isoformat(), "ends": dates[-1].isoformat()}
        if "submission" not in milestones:
            continue
        cycles.append({"id": f"arr_{year}_{title[1].lower()}", "name": f"{title[1].title()} {year}",
                       "year": year, "month": month, "evidence": " | ".join(row[:7]),
                       "milestones": milestones})
    return cycles


def parse_participating_venues(html):
    """The commitment-venue table. A month-only date such as "January, 2027" has no day."""
    venues = []
    for row in _rows(html, "participating-venues-table")[1:]:
        if len(row) < 3:
            continue
        year = re.search(r"20\d{2}", row[0])
        if not year:
            continue
        values = []
        for cell in row[1:3]:
            dates = _dates(cell, int(year[0]))
            values.append(dates[0].isoformat() if dates else "")
        venues.append({"venue": row[0], "final_arr_submission": values[0], "commitment": values[1],
                       "evidence": " | ".join(row[:3])})
    return venues


def cycle_items(cycles, link=ARR_DATES_URL):
    """Dataset rows for the cycles ARR lists: the submission deadline and the author response."""
    items = []
    for cycle in cycles:
        label = f"ARR {cycle['name']} cycle"
        group = f"ARR {cycle['name']}"
        items.append(dict(
            id=cycle["id"], name=f"ARR — {cycle['name']} cycle (direct submission)",
            venue_type="conference", venue_group=group, track="cycle", venue_family="ARR",
            submission_type="direct", deadline_label="ARR submission", deadline_aoe="",
            notification_aoe="", link=link))
        if isinstance(cycle["milestones"].get("author_response"), dict):
            items.append(dict(
                id=cycle["id"] + "_rebuttal", name=f"{label} (author response)",
                venue_type="rebuttal", venue_group=group, track="rebuttal", venue_family="ARR",
                deadline_label="initial author response", deadline_aoe="",
                notification_aoe="", link=link))
    return items


def cycle_schedule(cycle):
    """The cycle's milestones after the deadline row, as the schedule the board renders."""
    rows, milestones = [], cycle["milestones"]
    window = milestones.get("author_response")
    if isinstance(window, dict):
        rows.append({"milestone": "rebuttal", "label": "Author response period",
                     "starts": window["starts"], "ends": window["ends"], "kind": "period"})
    for key, milestone, label in (
        ("reviews_due", "reviews", "Reviews due"),
        ("meta_reviews", "notification", "Meta-reviews released"),
        ("cycle_end", "cycle_end", "Cycle ends"),
    ):
        if isinstance(milestones.get(key), str):
            rows.append({"milestone": milestone, "label": label, "date": milestones[key], "kind": "date"})
    return rows


def cycle_date_for(item_id, cycle):
    """(ISO date, evidence suffix) the table gives the row, or None."""
    milestones = cycle["milestones"]
    if item_id.endswith("_rebuttal"):
        window = milestones.get("author_response")
        return (window["ends"], "author response window " + window["starts"] + " to " + window["ends"]) \
            if isinstance(window, dict) else None
    return (milestones["submission"], "submission") if isinstance(milestones.get("submission"), str) else None


def venue_table_rows(venues):
    """Venue-table rows keyed by (lowercase venue name without year), for cross-checking CFPs."""
    return {re.sub(r"\s*20\d{2}\s*", "", row["venue"]).strip().lower(): row for row in venues}
