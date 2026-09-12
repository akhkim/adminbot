"""Exact OpenReview invitation observations and configured conference milestone refresh."""
import urllib.parse

from adminbot_deadlines import is_sweep_due
from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates, _candidate_is_abstract


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
CONFERENCE_INVITATIONS = {
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
                pages[cfp_url] = deadline_candidates_from_html(html, final_url, int(item["deadline_aoe"][:4]))[0]
            except Exception:
                pages[cfp_url] = []
        abstract = "abstract" in item.get("deadline_label", "")
        candidates = [candidate for candidate in pages[cfp_url] if _candidate_is_abstract(candidate) == abstract]
        result = reconcile_deadline_candidates(candidates, observation["duedate_aoe"] if observation else "",
                    "https://openreview.net/invitation?id=" + urllib.parse.quote(CONFERENCE_INVITATIONS[item["id"]], safe="/"),
                    int(item["deadline_aoe"][:4]), target_hint=item.get("deadline_label", ""))
        item["_source_observed"] = bool(result["deadline_aoe"])
        if not result["deadline_aoe"]:
            item["deadline_source_status"] = "source_unavailable"
            continue
        for key in ("deadline_aoe", "source_url", "deadline_source_kind", "deadline_source_status",
                    "deadline_source_precision", "deadline_source_evidence", "deadline_official_url",
                    "deadline_official_evidence"):
            item[key] = result[key]
        item["source_checked_at"] = checked_at()
        if observation:
            item["openreview_invitation"] = observation
    return refresh_conference_tables(items, previous_by_id, clock, force_refresh, fetch_html, checked_at)


# Match a named row and its date cell, never the nearest date in a whole conference page.
CONFERENCE_TABLE_ROWS = {
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
        url, label = CONFERENCE_TABLE_ROWS[item['id']]
        if url not in pages:
            try:
                pages[url] = fetch_html(url)[1]
            except Exception:
                pages[url] = ''
        observed = conference_table_deadline(pages[url], label, int(item['deadline_aoe'][:4]))
        item['_source_observed'] = bool(observed)
        if not observed:
            item['deadline_source_status'] = 'source_unavailable'
            continue
        date, evidence = observed
        item.update(deadline_aoe=date + ' 23:59:00', source_url=url,
                    deadline_source_kind='official_cfp', deadline_source_status='portal_unverified',
                    deadline_source_precision='date_only', deadline_source_evidence=evidence,
                    deadline_official_url=url, deadline_official_evidence=evidence,
                    source_checked_at=checked_at())
    return items
