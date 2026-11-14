"""Exact OpenReview invitation observations and configured conference milestone refresh."""
import urllib.parse
import re

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
    'arr_2026_may': ('https://aclrollingreview.org/dates', r'May 2026'),
    'arr_2026_august': ('https://aclrollingreview.org/dates', r'August 2026'),
    'arr_2026_october': ('https://aclrollingreview.org/dates', r'October 2026'),
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
    'arr_2026_may': 'aclweb.org/ACL/ARR/2026/May/-/Submission',
    'arr_2026_august': 'aclweb.org/ACL/ARR/2026/August/-/Submission',
    'arr_2026_october': 'aclweb.org/ACL/ARR/2026/October/-/Submission',
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
           if item.get('_primary_attempted') and item['id'] in CONFERENCE_OPENREVIEW_CHECKS]
    if not due:
        return items
    observations = read_invitations(sorted({CONFERENCE_OPENREVIEW_CHECKS[item['id']] for item in due}))
    for item in due:
        invitation = CONFERENCE_OPENREVIEW_CHECKS[item['id']]
        observation = observations.get(invitation)
        if not observation:
            continue
        portal = observation['duedate_aoe']
        url = 'https://openreview.net/invitation?id=' + urllib.parse.quote(invitation, safe='/')
        item['openreview_invitation'] = observation
        same_date = item.get('deadline_aoe', '')[:10] == portal[:10]
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
