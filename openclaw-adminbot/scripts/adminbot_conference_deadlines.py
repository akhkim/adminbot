"""Exact OpenReview invitation observations and configured conference milestone refresh."""
import datetime
import urllib.parse
import re

from adminbot_arr_dates import (
    ARR_DATES_URL, cycle_date_for, cycle_items, cycle_schedule, parse_arr_cycles,
    parse_participating_venues, venue_table_rows,
)
from adminbot_deadlines import is_sweep_due
from adminbot_deadline_time import TIME_FIELDS, timing_fields
from adminbot_schedule_sources import source_text
from adminbot_workshop_deadlines import (
    _all_dates, _candidate_is_abstract, _candidate_stamp, _global_aoe_time,
    deadline_candidates_from_html, reconcile_deadline_candidates,
)


def fetch_invitation_observations(invitation_ids, fetch, to_aoe, batch_size=40):
    """Read exact public invitation IDs named by the venue, keeping expiry separate."""
    observations = {}
    for start in range(0, len(invitation_ids), batch_size):
        ids = invitation_ids[start:start + batch_size]
        query = urllib.parse.urlencode([("expired", "true")] + [("ids", value) for value in ids])
        try:
            response = fetch("https://api2.openreview.net/invitations?" + query, timeout=60)
        except Exception:
            continue
        for invitation in response.get("invitations", []):
            due = invitation.get("duedate")
            if invitation.get("id") not in ids or not isinstance(due, (int, float)) or due <= 0:
                continue
            observation = {"id": invitation["id"], "duedate_aoe": to_aoe(due)}
            expiration = invitation.get("expdate")
            if isinstance(expiration, (int, float)) and expiration > 0:
                observation["expdate_aoe"] = to_aoe(expiration)
            observations[invitation["id"]] = observation
    return observations


# Each mapping names one specific milestone; never map an abstract invitation to a paper row.
ICML_CFP = "https://icml.cc/Conferences/2027/CallForPapers"
COLING_CFP = "https://2027.coling-iccl.org/calls/main_conference_papers/"
CONFERENCE_LIST_STAGES = {
    "icml2027_abstract": (ICML_CFP, "Abstract submission deadline", 2027),
    "community_f43e7729-6593-4aed-90fd-fca5ff390806": (ICML_CFP, "Full paper submission deadline", 2027),
    "community_207f3047-46da-4ce9-9805-ccccd048cb56": (COLING_CFP, "Commitment after meta-reviews", 2026),
}

CONFERENCE_INVITATIONS = {
    "community_9e9c9619-a1ac-41f9-b67e-05dfd81accf5": "cclear.cc/CLeaR/2027/Conference/-/Submission",
    "iclr2027_abstract": "ICLR.cc/2027/Conference/-/Submission",
    "iclr2027_paper": "ICLR.cc/2027/Conference/-/Full_Submission",
    "eacl2027_demo": "eacl.org/EACL/2027/Demo/-/Submission",
}


def refresh_configured_conferences(items, previous_by_id, clock, force_refresh=False, *, read_invitations, fetch_html, checked_at):
    cycles, venues = discover_arr_cycles(items, previous_by_id, clock, fetch_html)
    due = []
    for item in items:
        if item["id"] not in CONFERENCE_INVITATIONS:
            continue
        previous = previous_by_id.get(item["id"], {})
        if previous:
            item.update(previous)
        if force_refresh or is_sweep_due(clock, "conference", item["deadline_aoe"], item.get("source_checked_at")):
            item["_primary_attempted"] = True
            due.append(item)
    observations = read_invitations([CONFERENCE_INVITATIONS[item["id"]] for item in due])
    pages = {}
    for item in due:
        observation = observations.get(CONFERENCE_INVITATIONS[item["id"]])
        cfp_url = ("https://iclr.cc/Conferences/2027/CallForPapers"
                   if item["id"].startswith("iclr2027_") else item["link"])
        if cfp_url not in pages:
            try:
                final_url, html = fetch_html(cfp_url)
                pages[cfp_url] = deadline_candidates_from_html(html, final_url, int(item["deadline_aoe"][:4] or str(clock.today.year)))[0]
            except Exception:
                pages[cfp_url] = []
        abstract = "abstract" in item.get("deadline_label", "")
        candidates = [candidate for candidate in pages[cfp_url] if _candidate_is_abstract(candidate) == abstract]
        result = reconcile_deadline_candidates(candidates, observation["duedate_aoe"] if observation else "",
                    "https://openreview.net/invitation?id=" + urllib.parse.quote(CONFERENCE_INVITATIONS[item["id"]], safe="/"),
                    int(item["deadline_aoe"][:4] or str(clock.today.year)), target_hint=item.get("deadline_label", ""))
        item["_source_observed"] = bool(result["deadline_aoe"])
        if not result["deadline_aoe"]:
            item["deadline_source_status"] = "source_unavailable"
            continue
        for key in ("deadline_aoe", "source_url", "deadline_source_kind", "deadline_source_status",
                    "deadline_source_precision", "deadline_source_evidence", "deadline_official_url",
                    "deadline_official_evidence", *TIME_FIELDS):
            item[key] = result[key]
        item["source_checked_at"] = checked_at()
        if observation:
            item["openreview_invitation"] = observation
    refresh_conference_lists(items, clock, force_refresh, fetch_html, checked_at)
    refresh_conference_tables(items, previous_by_id, clock, force_refresh, fetch_html, checked_at)
    refresh_arr_cycles(items, cycles, venues, checked_at)
    return confirm_with_openreview(items, read_invitations, checked_at)


def refresh_conference_lists(items, clock, force_refresh, fetch_html, checked_at):
    pages = {}
    for item in items:
        source = CONFERENCE_LIST_STAGES.get(item["id"])
        if not source or not (force_refresh or is_sweep_due(
            clock, "conference", item["deadline_aoe"], item.get("source_checked_at")
        )):
            continue
        item["_primary_attempted"] = True
        url, label, year = source
        if url not in pages:
            try:
                final_url, html = fetch_html(url)
                pages[url] = source_text(html).splitlines() if final_url == url else []
            except Exception:
                pages[url] = []
        matches = [line for line in pages[url] if line.casefold().startswith(label.casefold() + ":")]
        evidence = matches[0] if len(matches) == 1 else ""
        dates = _all_dates(evidence, year)
        if len(dates) != 1:
            item["deadline_source_status"] = "source_unavailable"
            continue
        start, end, date = dates[0]
        stamp, precision, zone = _candidate_stamp(evidence, start, end, date)
        # A missing clock must not downgrade an already verified exact cutoff.
        date_only = precision == "date-only" or precision.endswith("-date")
        if date_only and item.get("deadline_time_precision") == "exact":
            item["deadline_source_status"] = "source_unavailable"
            continue
        item.update(timing_fields(stamp, date_only=date_only, timezone=zone))
        item.update(_source_observed=True, source_url=url,
                    deadline_source_kind="official_cfp", deadline_source_status="portal_unverified",
                    deadline_source_precision="date_only" if date_only else "exact",
                    deadline_source_evidence=evidence, deadline_official_url=url,
                    deadline_official_evidence=evidence, source_checked_at=checked_at())


# Match a named row and its date cell, never the nearest date in a whole conference page.
CONFERENCE_TABLE_ROWS = {
    'aistats2027_abstract': (
        'https://virtual.aistats.org/Conferences/2027/CallForPapers', r'Abstract submission deadline'
    ),
    'aistats2027_paper': (
        'https://virtual.aistats.org/Conferences/2027/CallForPapers',
        r'Full paper submission deadline \(including all supplementary material\)'
    ),
    'community_91ccb05a-8e08-4684-bcbe-aa5b3a53c0fa': (
        'https://2027.aclweb.org/calls/main/', r'ARR submission deadline \(long & short papers\)'
    ),
    'aacl2026_commitment': ('https://2026.aaclnet.org/calls/main_conference_papers/', r'Commitment deadline'),
    'aacl2026_commitment_second': ('https://2026.aaclnet.org/calls/main_conference_papers/', r'Second-round commitment deadline'),
    'aacl2026_demo': ('https://2026.aaclnet.org/calls/demos/', r'Paper Submission Deadline'),
    'emnlp2026_commitment': ('https://2026.emnlp.org/calls/main_conference_papers/', r'EMNLP commitment deadline'),
    'eacl2027_commitment': ('https://2027.eacl.org/calls/papers/', r'EACL 2027 commitment deadline'),
    'naacl2027_paper': ('https://2027.naacl.org/calls/main_conference_papers/', r'ARR submission deadline \(long & short papers\)'),
    'naacl2027_commitment': ('https://2027.naacl.org/calls/main_conference_papers/', r'NAACL commitment deadline'),
}


def conference_table_deadline(html, label, year):
    import re
    from html.parser import HTMLParser
    from adminbot_workshop_deadlines import _all_dates

    class Rows(HTMLParser):
        def __init__(self):
            super().__init__()
            self.rows, self.row, self.cell = [], None, None
            self.old_depth = 0
        def handle_starttag(self, tag, attrs):
            if tag in ('s', 'del', 'strike'): self.old_depth += 1
            if tag == 'tr': self.row = []
            elif tag in ('td', 'th') and self.row is not None: self.cell = []
        def handle_data(self, data):
            if self.cell is not None and not self.old_depth: self.cell.append(data)
        def handle_endtag(self, tag):
            if tag in ('s', 'del', 'strike'): self.old_depth = max(0, self.old_depth - 1)
            if tag in ('td', 'th') and self.cell is not None:
                self.row.append(' '.join(' '.join(self.cell).split()))
                self.cell = None
            elif tag == 'tr' and self.row is not None:
                self.rows.append(self.row)
                self.row = None

    parser = Rows()
    parser.feed(html)
    matches = [row for row in parser.rows if len(row) >= 2 and re.fullmatch(label, row[0], re.I)]
    if len(matches) != 1:
        return None
    dates = list(_all_dates(matches[0][1], year))
    if len(dates) != 1:
        return None
    date = dates[0][2]
    return date.isoformat(), ' | '.join(matches[0][:2])


def refresh_conference_tables(items, previous_by_id, clock, force_refresh, fetch_html, checked_at):
    pages = {}
    for item in items:
        if item['id'] not in CONFERENCE_TABLE_ROWS:
            continue
        previous = previous_by_id.get(item['id'], {})
        if previous:
            item.update(previous)
        if not force_refresh and not is_sweep_due(clock, 'conference', item['deadline_aoe'], item.get('source_checked_at')):
            continue
        item['_primary_attempted'] = True
        url, label = CONFERENCE_TABLE_ROWS[item['id']]
        if url not in pages:
            try:
                pages[url] = fetch_html(url)[1]
            except Exception:
                pages[url] = ''
        edition = re.search(r"20\d{2}", item.get("venue_group", ""))
        year = item.get("source_year") or int(
            item["deadline_aoe"][:4] or (edition[0] if edition else clock.today.year)
        )
        observed = conference_table_deadline(pages[url], label, year)
        item['_source_observed'] = bool(observed)
        if not observed:
            item['deadline_source_status'] = 'source_unavailable'
            continue
        date, evidence = observed
        page = re.sub(r"<[^>]*>", " ", pages[url])
        global_time = _global_aoe_time(page)
        if global_time:
            hour, minute = global_time
            item.update(timing_fields(f"{date} {hour:02d}:{minute:02d}:00", timezone="AoE"))
        elif item.get("deadline_time_precision") == "exact" and item.get("deadline_aoe", "")[:10] == date:
            # The page repeats the known date without a clock. Keeping the exact cutoff matters:
            # a date-only reading would replace it with the earliest instant that date can mean.
            pass
        else:
            zone = "AoE" if re.search(r"(?i)all\s+deadlines.{0,100}(?:AoE|Anywhere\s+on\s+Earth)", page) else ""
            item.update(timing_fields(date, date_only=True, timezone=zone))
        item.update(source_url=url,
                    deadline_source_kind='official_cfp', deadline_source_status='portal_unverified',
                    deadline_source_precision='exact' if global_time else 'date_only', deadline_source_evidence=evidence,
                    deadline_official_url=url, deadline_official_evidence=evidence,
                    source_checked_at=checked_at())
    return items


# The portal behind a row that is read from a CFP page. Same rule as CONFERENCE_INVITATIONS: one
# invitation per milestone, and only where the invitation closes on the row's own cutoff. An
# invitation that does not exist yet costs nothing -- the row simply stays portal_unverified
# until the venue opens it.
CONFERENCE_OPENREVIEW_CHECKS = {
    'community_f43e7729-6593-4aed-90fd-fca5ff390806': 'ICML.cc/2027/Conference/-/Submission',
    # AISTATS closes its Submission invitation on the abstract date; the paper has no invitation.
    'aistats2027_abstract': 'aistats.org/AISTATS/2027/Conference/-/Submission',
    'naacl2027_paper': 'aclweb.org/ACL/ARR/2026/October/-/Submission',
    'emnlp2026_commitment': 'EMNLP/2026/Conference/-/Submission',
}


def confirm_with_openreview(items, read_invitations, checked_at):
    """Check CFP-sourced rows against their portal, and fall back to it when the CFP is down.

    Three outcomes, and only two of them change the row. Agreement on the date upgrades the row
    from an announced date to a confirmed one and takes the portal's clock, which is the cutoff
    authors actually meet. A CFP that could not be read falls back to the portal, so a venue
    redesigning its site no longer stales a deadline the portal still publishes. A disagreement
    changes nothing but the recorded evidence: these mappings are matched by hand rather than by an abstract/paper
    reconciliation, so the CFP stays in charge and the portal's date is recorded beside it.
    """
    due = [item for item in items
           if item.get('_primary_attempted') and openreview_invitation(item['id'])]
    if not due:
        return items
    observations = read_invitations(sorted({openreview_invitation(item['id']) for item in due}))
    for item in due:
        invitation = openreview_invitation(item['id'])
        observation = observations.get(invitation)
        if not observation:
            continue
        portal = observation['duedate_aoe']
        url = 'https://openreview.net/invitation?id=' + urllib.parse.quote(invitation, safe='/')
        item['openreview_invitation'] = observation
        # A date-only row stores the earliest instant its date can mean, which is a day or two
        # before the announced date, so compare the announced date itself.
        announced = (item.get('deadline_date') if item.get('deadline_time_precision') == 'date_only'
                     else '') or item.get('deadline_aoe', '')[:10]
        same_date = announced == portal[:10]
        if item.get('deadline_source_status') == 'source_unavailable':
            # A portal date that contradicts the last CFP reading is not a fallback; it is a
            # conflict nobody has looked at. Leave the row unobserved with the evidence attached.
            if item.get('deadline_aoe') and not same_date:
                continue
            item.update(timing_fields(portal, timezone='UTC'))
            item.update(_source_observed=True, source_url=url, deadline_source_kind='openreview',
                        deadline_source_status='openreview_only', deadline_source_precision='exact',
                        deadline_source_evidence='Official page unavailable; matched OpenReview invitation cutoff.',
                        source_checked_at=checked_at())
        elif same_date:
            item.update(timing_fields(portal, timezone='UTC'))
            item.update(deadline_source_status='official_date_matches_openreview')
    return items


def openreview_invitation(item_id):
    """The portal invitation for a row: the fixed mappings, or an ARR cycle's own submission one."""
    if item_id in CONFERENCE_OPENREVIEW_CHECKS:
        return CONFERENCE_OPENREVIEW_CHECKS[item_id]
    match = re.fullmatch(r'arr_(\d{4})_([a-z]+)', item_id)
    return f'aclweb.org/ACL/ARR/{match[1]}/{match[2].title()}/-/Submission' if match else None


# ARR's venue table lists each venue's commitment date. A venue's own CFP stays in charge of its
# row; the table is a second official source, and the two are compared, never merged.
VENUE_TABLE_KEYS = {
    'emnlp2026_commitment': 'emnlp',
    'aacl2026_commitment': 'aacl',
    'eacl2027_commitment': 'eacl',
    'naacl2027_commitment': 'naacl',
    'community_207f3047-46da-4ce9-9805-ccccd048cb56': 'coling',
}
ARR_CYCLE_ID = re.compile(r'arr_\d{4}_[a-z]+(?:_rebuttal)?')
# A cycle stays listed on the board for a month after it ends, then drops out of discovery.
ARR_CYCLE_GRACE_DAYS = 30


def discover_arr_cycles(items, previous_by_id, clock, fetch_html):
    """Add one row per cycle on ARR's dates page, and carry earlier cycles forward.

    Cycles come from the page, not from code, so a newly announced cycle needs no release. A cycle
    that has left the page keeps its stored row (it goes stale, never disappears). The parsed
    cycles are returned for the refresh and schedule steps; an unreachable page returns [].
    """
    try:
        final_url, html = fetch_html(ARR_DATES_URL)
        cycles = parse_arr_cycles(html)
        venues = parse_participating_venues(html)
    except Exception:
        cycles, venues = [], []
    cutoff = clock.today - datetime.timedelta(days=ARR_CYCLE_GRACE_DAYS)
    live = [cycle for cycle in cycles
            if datetime.date.fromisoformat(cycle['milestones'].get('cycle_end', cycle['milestones']['submission'])) >= cutoff]
    known = {item['id'] for item in items}
    for row in cycle_items(live):
        if row['id'] not in known:
            merged = dict(previous_by_id.get(row['id'], {}))
            merged.update({key: value for key, value in row.items() if key not in {'deadline_aoe', 'notification_aoe'}})
            merged['_source_observed'] = False
            items.append(merged)
            known.add(row['id'])
    for deadline_id in previous_by_id:
        if ARR_CYCLE_ID.fullmatch(deadline_id) and deadline_id not in known:
            items.append(dict(previous_by_id[deadline_id], _source_observed=False))
            known.add(deadline_id)
    return cycles, venues


def refresh_arr_cycles(items, cycles, venues, checked_at):
    """Set every ARR cycle row from the official table, then compare venue commitments to it."""
    by_id = {cycle['id']: cycle for cycle in cycles}
    for item in items:
        match = ARR_CYCLE_ID.fullmatch(item['id'])
        if not match:
            continue
        cycle = by_id.get(item['id'].removesuffix('_rebuttal'))
        item['_primary_attempted'] = True
        observed = cycle_date_for(item['id'], cycle) if cycle else None
        if not observed:
            item['_source_observed'] = False
            item['deadline_source_status'] = 'source_unavailable' if item.get('deadline_aoe') else item.get('deadline_source_status', '')
            continue
        date, what = observed
        evidence = f"{cycle['evidence']} ({what})"
        if item.get('deadline_time_precision') == 'exact' and item.get('deadline_aoe', '')[:10] == date:
            pass  # An OpenReview-confirmed clock for the same day stays; a date-only reading would lose it.
        else:
            item.update(timing_fields(date, date_only=True, timezone=''))
        item.update(_source_observed=True, source_url=ARR_DATES_URL, deadline_source_kind='official_cfp',
                    deadline_source_status='portal_unverified', deadline_source_precision='date_only',
                    deadline_source_evidence=evidence, deadline_official_url=ARR_DATES_URL,
                    deadline_official_evidence=evidence, source_checked_at=checked_at(),
                    schedule=cycle_schedule(cycle), schedule_status='verified')
        item.pop('deadline_conflict_evidence', None)
    table = venue_table_rows(venues)
    for item in items:
        key = VENUE_TABLE_KEYS.get(item['id'])
        row = table.get(key or '')
        if not row or not row['commitment'] or item.get('deadline_source_kind') != 'official_cfp':
            continue
        announced = (item.get('deadline_date') if item.get('deadline_time_precision') == 'date_only'
                     else '') or item.get('deadline_aoe', '')[:10]
        if announced and announced != row['commitment']:
            item['deadline_source_status'] = 'official_sources_disagree'
            item['deadline_conflict_evidence'] = (
                f"ARR dates page lists the {row['venue']} commitment on {row['commitment']} "
                f"({row['evidence']}); the venue's own call lists {announced}.")
    return items
