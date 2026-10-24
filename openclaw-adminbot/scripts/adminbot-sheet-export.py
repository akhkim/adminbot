#!/usr/bin/env python3
"""Prepare a one-way, allowlisted Sheets values batch. Run on the database host."""
import argparse
import datetime
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl
from zoneinfo import ZoneInfo

PEOPLE = ('id', 'name', 'member_type', 'status', 'affiliation', 'research_topics')
TORONTO = ZoneInfo('America/Toronto')
# Review-link label -> (payload artifact keys, slot names), in the order the PI should open them.
# First usable URL per label wins; slots before artifacts; a URL already shown is not repeated.
PAPER_LINKS = {
    'Overleaf edit': (('overleaf_edit_url',), ('overleaf_edit',)),
    'Overleaf share': (('overleaf_share_url',), ('overleaf_share',)),
    'Overleaf view': (('overleaf_view_url',), ('overleaf_view',)),
    'PDF': (('google_drive_pdf_url',), ('drive_pdf_arxiv',)),
    'arXiv': (('arxiv_url',), ('arxiv',)),
    'Submission': (('submission_url',), ('submission',)),
    'Project folder': ((), ('project_folder',)),
    'Slides': (('google_slides_url',), ('slides',)),
    'Poster': (('poster_url',), ('poster',)),
    'GitHub': (('github_url',), ()),
    'Rebuttal': ((), ('rebuttal_doc',)),
    'Talk video': ((), ('talk_video',)),
    'Brainstorming doc': (('brainstorming_doc_url',), ()),
    'X draft': (('twitter_draft_url',), ()),
    'LinkedIn draft': (('linkedin_draft_url',), ()),
    'X post': ((), ('x_post',)),
    'LinkedIn post': ((), ('linkedin_post',)),
}
LINK_SLOTS = sorted({slot for _, slots in PAPER_LINKS.values() for slot in slots})
LINK_OF_SLOT = {slot: label for label, (_, slots) in PAPER_LINKS.items() for slot in slots}
PAPER_ID = 'ID'
# Sheet-only venue notes for papers with no venue in AdminBot. A real AdminBot venue always wins.
VENUE_NOTES = {
    'subliminal-learning-through-useful-math': 'Not ARR (per PI, Oct 11 2026)',
    'uka-clinical-post-training': 'Not ARR (per PI, Oct 11 2026)',
}
# Plain-language layout: what the PI acts on first, links next, record-keeping detail last.
PAPERS = ('Paper', 'Urgency', 'PI review', 'Paper state', 'Review for', 'Review link', 'Due (Toronto)', 'Authors',
          'Requested by', 'Requested on', 'Request note', 'Conference', 'Year', 'Track', 'Presentation', 'Venue',
          'Venue deadline (Toronto)', 'OpenReview', 'Submission history', 'Source', 'Stage', 'Lead', 'Incomplete', 'Blocker / next step', 'Link problems', 'Still missing', 'Mentor review', 'Co-author feedback', 'Accepted',
          'Going to conference', 'Started', 'Last updated', 'Feedback givers', 'Checks',
          'Venue (as entered)', 'All artifact statuses', PAPER_ID)
LINK_COLUMNS = ('Review link',)
LINK_SEPARATOR = ' · '
# When nothing sets a due date, more deadline-bound review types come first.
REVIEW_PRIORITY = ('ARR feedback', 'Camera-ready feedback', 'Publication approval', 'Other feedback', 'arXiv feedback')
STAGES = {'brainstorming_docs': '1 · Brainstorming', 'overleaf_writing': '2 · Writing (Overleaf)',
          'submission': '3 · Submission', 'google_drive_pdf': '4 · PDF on Drive',
          'arxiv_polish': '5 · arXiv polish', 'slide_making': '6 · Slides',
          'poster_making': '7 · Poster', 'social_posts': '8 · Social posts'}
PRE_SUBMISSION = {'brainstorming_docs', 'overleaf_writing', 'submission'}
# Venues whose papers go through ACL Rolling Review.
ARR_FAMILY = ('ACL', 'EMNLP', 'NAACL', 'EACL', 'AACL', 'IJCNLP', 'COLING', 'ARR')
SLOT_LABELS = {'drive_pdf_arxiv': 'PDF', 'overleaf_edit': 'Overleaf edit', 'overleaf_view': 'Overleaf view',
               'overleaf_share': 'Overleaf share', 'authors_ack': 'Authors sign-off',
               'pi_approval': 'PI approval', 'coauthor_feedback': 'Co-author feedback',
               'papermentor_review': 'Mentor review', 'project_folder': 'Project folder'}


def slot_label(slot):
    return SLOT_LABELS.get(slot, slot.replace('_', ' ').capitalize())


def review_type(slot):
    """feedback_arr -> 'ARR feedback'; the PI sees what the review is for, never a conference."""
    kind = slot.removeprefix('feedback_')
    return {'arr': 'ARR feedback', 'arxiv': 'arXiv feedback', 'camera_ready': 'Camera-ready feedback',
            'other': 'Other feedback'}.get(kind, kind.replace('_', ' ').capitalize() + ' feedback')


def parse_time(value):
    try:
        moment = datetime.datetime.fromisoformat(str(value).strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=datetime.timezone.utc)


def toronto(moment, with_time=True):
    if not moment:
        return ''
    local = moment.astimezone(TORONTO)
    text = local.strftime('%a %b %-d, %Y')
    return text + local.strftime(', %-I:%M %p') if with_time else text


def stamp(moment, with_time=True):
    """Toronto time written year-first, so a column of them sorts by date as plain text:
    '2026-10-13 08:00 (Tue)', or '2026-10-13 (Tue)' without the time."""
    if not moment:
        return ''
    local = moment.astimezone(TORONTO)
    return local.strftime('%Y-%m-%d %H:%M (%a)' if with_time else '%Y-%m-%d (%a)')


# One standard conference name per paper, so the sheet filters and sorts by conference however the
# venue was typed. Checked in order: a paper going through ARR is filed under the conference it
# commits to when one is named, and a workshop at a named conference is filed under that conference
# (its Track says Workshop). Anything unmatched is 'Other' and should get a rule here.
CONFERENCES = (('EMNLP', r'\bEMNLP\b'), ('NAACL', r'\bNAACL\b'),
               ('EACL', r'\bEACL\b'), ('AACL', r'\bAACL\b'), ('ACL', r'\bACL\b'), ('ICLR', r'\bICLR\b'),
               ('NeurIPS', r'\bNeurIPS\b'), ('ICML', r'\bICML\b'), ('COLM', r'\bCOLM\b'), ('AAAI', r'\bAAAI\b'),
               ('KDD', r'\bKDD\b'), ('AISTATS', r'\bAISTATS\b'), ('CogSci', r'\bCogSci\b'), ('IASEAI', r'\bIASEAI\b'), ('CLeaR', r'\bCLeaR\b'), ('ICSSI', r'\bICSSI\b'), ('DevAI', r'\bDevAI\b'),
               ('Workshop', r'workshop|\bAI4GOOD\b'), ('Journal', r'\bJMLR\b|\bTMLR\b|journal'), ('ARR (conference not set)', r'\bARR\b'),
               ('Preprint', r'preprint|arxiv'))


# Not one conference: OpenReview naming only these leaves the typed venue to decide.
UNNAMED_CONFERENCES = ('Not set', 'Other', 'ARR (conference not set)', 'Preprint')


def conference(*venues):
    """'ARR · May 2026 → EMNLP 2026 Findings' -> 'EMNLP'; '' -> 'Not set'; unmatched -> 'Other'."""
    text = ' '.join(v for v in venues if v)
    if not text.strip():
        return 'Not set'
    return next((name for name, pattern in CONFERENCES if re.search(pattern, text, re.I)), 'Other')


# ACL Rolling Review calendar (aclrollingreview.org/dates, checked 2026-10-11). Deadlines are 23:59 AoE.
# Each venue lists the LAST cycle that can commit to it. Published ARR deadlines in the database extend this.
ARR_CYCLES = {'Mar 2026': '2026-03-16', 'May 2026': '2026-05-25', 'Aug 2026': '2026-08-03',
              'Oct 2026': '2026-10-12', 'Jan 2027': '2027-01-04'}
ARR_LAST_CYCLE = {('EMNLP', '2026'): 'May 2026', ('AACL', '2026'): 'May 2026', ('EACL', '2027'): 'Aug 2026',
                  ('NAACL', '2027'): 'Oct 2026', ('COLING', '2027'): 'Oct 2026', ('ACL', '2027'): 'Jan 2027'}
CANONICAL_VENUES = {v.upper(): v for v in (*ARR_FAMILY, 'ICLR', 'ICML', 'NeurIPS', 'AAAI', 'COLM', 'IJCAI',
                                           'CVPR', 'KDD', 'TMLR', 'JMLR', 'FAccT', 'AIES', 'CHI', 'IUI')}
# A missed hard venue deadline stays visible this long; an arXiv feedback request gets this many days for review.
OVERDUE_DAYS = 14
ARXIV_REVIEW_DAYS = 7
MONTHS = ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')


def aoe(date):
    return datetime.datetime.fromisoformat(date + 'T23:59').replace(tzinfo=ZoneInfo('Etc/GMT+12'))


def arr_calendar(deadlines):
    """(cycles: label -> deadline, last cycle per (venue, year)), merged with published ARR deadlines."""
    cycles = {label: aoe(date) for label, date in ARR_CYCLES.items()}
    last = dict(ARR_LAST_CYCLE)
    for d in deadlines:
        if d['type'] == 'arr_direct_submission':
            label = d['at'].astimezone(ZoneInfo('Etc/GMT+12')).strftime('%b %Y')
            cycles.setdefault(label, d['at'])
            key = (d['conference'].upper(), d['year'])
            if key not in last or cycles[label] > cycles[last[key]]:
                last[key] = label
    return dict(sorted(cycles.items(), key=lambda item: item[1])), last


def venue_info(record, slots, deadlines, now):
    """Uniform venue text plus the deadline that matters for it.

    ARR route: 'ARR · Oct 2026', and '→ NAACL 2027 Findings' only once committed. Others: 'ICLR 2027'.
    """
    artifacts = record.get('artifacts') or {}
    raw = ' '.join(str(record.get('venue') or artifacts.get('conference') or '').split())
    accepted = record.get('venue_decision') == 'accept' and record.get('accepted_venue')
    source = str(record.get('accepted_venue')) if accepted else raw
    if not source:
        return '', None
    committed_to = re.search(r'committed to ([^,;]+)', source, re.I)
    name = committed_to.group(1) if committed_to else source
    name = re.sub(r'^(to be |findings of )', '', name, flags=re.I)
    name = re.sub(r'\s*\((main|findings)\)|\bfindings\b', '', name, flags=re.I).strip(' ,')
    base = re.split(r'[\s(@-]', name)[0].upper()
    if base in CANONICAL_VENUES:  # 'iclr 2027' -> 'ICLR 2027'
        name = CANONICAL_VENUES[base] + name[len(base):]
    year = re.search(r'\b20\d{2}\b', name) or re.search(r'\b20\d{2}\b', raw)
    year = year.group(0) if year else str(record.get('accepted_year') or '') if accepted else ''
    if year and year not in name:
        name += ' ' + year
    is_arr = base in ARR_FAMILY or bool(re.search(r'\barr\b', raw, re.I))
    pre_submission = record.get('current_step') in PRE_SUBMISSION and not record.get('under_review')
    camera_ready = venue_deadline(base, year, deadlines, now, camera_ready=True) if accepted else None
    if not is_arr:
        deadline = venue_deadline(base, year, deadlines, now) if pre_submission else camera_ready
        return name, deadline
    cycles, last = arr_calendar(deadlines)
    committed = bool(accepted or committed_to or re.search(r'\bacceptance\b', raw, re.I))
    cycle = None
    month = re.search(r'\b(' + '|'.join(MONTHS) + r')[a-z]*\.?\s*(20\d{2})?', raw, re.I)
    if month and re.search(r'\barr\b', raw, re.I):  # 'ARR October 2026' names the cycle outright
        wanted = month.group(1).capitalize()
        options = [label for label in cycles if label.startswith(wanted)
                   and (not month.group(2) or label.endswith(month.group(2)))]
        cycle = min(options, key=lambda label: abs(cycles[label] - now), default=None)
    elif pre_submission and not committed:
        cycle = next((label for label, at in cycles.items() if at >= now), None)
    else:
        submitted = parse_time(next((s.get('provided_at') for s in slots
                                     if s['slot'] == 'submission' and s['status'] == 'provided'), '') or '')
        cycle = next((label for label, at in reversed(cycles.items())
                      if submitted and at <= submitted + datetime.timedelta(days=1)), None)
        # A guessed cycle must be one the committed venue could take ('Aug 2026 → ACL 2026' is impossible).
        if cycle and committed and ((base, year) not in last or cycles[cycle] > cycles.get(last[(base, year)], now)):
            cycle = None
    text = 'ARR · ' + cycle if cycle else 'ARR'
    if committed and base != 'ARR':
        track = 'Findings' if ('findings' in source.lower() or artifacts.get('publication_track') == 'findings') else ''
        text += ' → ' + ' '.join(x for x in (name, track) if x)
    elif not cycle:
        text += ' · cycle not recorded'
    deadline = None
    if cycle and pre_submission and not committed and cycles[cycle] >= now:
        deadline = {'name': 'ARR ' + cycle, 'at': cycles[cycle]}
    return text, deadline or camera_ready


def deadline_kind(d):
    """'hard' (submission, full paper, camera-ready), 'soft' (abstract, registration, early) or None (not an author deadline)."""
    text = f"{d.get('milestone', '')} {d.get('label', '')}".lower().replace('_', ' ')
    if any(word in text for word in ('notification', 'notify', 'conference date', 'event')):
        return None
    if any(word in text for word in ('abstract', 'registration', 'early', 'intent')):
        return 'soft'
    return 'hard'


def venue_deadline(base, year, deadlines, now, camera_ready=False):
    """Next hard deadline for the venue, with any earlier soft one (an abstract) attached as 'soft'.

    A hard deadline that passed in the last OVERDUE_DAYS is still returned, so a paper stuck before
    submission shows as overdue instead of silently losing its deadline.
    """
    def wanted(d):
        if not base or not (d['conference'].upper() == base or d['name'].upper().startswith(base)):
            return False
        if year and d['year'] not in ('', year) or d['type'] == 'arr_direct_submission':
            return False
        return ('camera' in (d.get('milestone', '') + d.get('label', '')).lower()) == camera_ready
    mine = sorted((d for d in deadlines if wanted(d) and deadline_kind(d)), key=lambda d: d['at'])
    hard = [d for d in mine if deadline_kind(d) == 'hard' and d['at'] >= now - datetime.timedelta(days=OVERDUE_DAYS)]
    upcoming = [d for d in hard if d['at'] >= now]
    chosen = upcoming[0] if upcoming else (hard[-1] if hard else None)
    soft = next((d for d in mine if deadline_kind(d) == 'soft' and d['at'] >= now
                 and (not chosen or d['at'] <= chosen['at'])), None)
    if not chosen:
        return dict(soft, soft_only=True) if soft else None
    return dict(chosen, soft=soft) if soft else chosen


def deadline_name(d):
    label = d.get('label', '')
    return d['name'] + (f' ({label})' if label and label.lower() != 'paper submission' else '')


PEOPLE_COLUMNS = tuple('''id join_date join_date_basis slack_active membership_review preferred_name member_type
test_onboard_batch receives_nudges email calendar_email slack_user_id merch_requests
next_position personal_circumstances slack_messages_7d slack_activity_checked_at
privilege_level collaborator_subgroup access_overrides notes role status research_branch
research_topics elevator_pitch projects hours_per_week location current_city
city_channel_invited_at city_channels_invited affiliation timezone personal_website
openreview_id cv_url intake_form_url intake_form_unavailable one_on_one_folder_url
linkedin_url linkedin_urn twitter_url github_url scholar_url reviewer_exempt joined_month
graduated_month birthday whatsapp correspondence_email dcs_username at_uoft compute_access
vector_role lesswrong_url other_socials avatar_url slack_channels slack_location
slack_location_updated_at profile_photo_review last_login_at last_login_country
last_login_continent last_login_city last_login_timezone location_prompt_answered_at
location_prompt_answered_country availability time_off milestones trips dismissed_deadlines
availability_notes availability_doc_url cv_snapshot availability_updated_at created_at
updated_at access onboarding_steps_total onboarding_completed_count onboarding_remaining_count
onboarding_current_step onboarding_completed_ids onboarding_remaining_ids
onboarding_last_nudged_at onboarding_opened_at onboarding_reason field_provenance
login_account_email login_account_claimed_at login_account_updated_at registration_status
registration_decided badges badge_count badge_nominations location_observations
location_last_observed login_count login_first_at login_last_at login_last_place
login_countries_seen login_cities_seen cv_changes_count cv_changes_last cv_changes_recency
notifications_total notifications_unread notifications_last_at notification_kinds nudges_count
tab_visits_count logistics_requests paper_weekly_updates conference_attendances name
password_resets feedback_submitted active_sessions paper_slots_provided paper_slots_waived
papers_authored_count papers_authored papers_submitted_count papers_submitted
audit_events_as_actor update_events_as_actor update_events_as_subject calendar_group search'''.split())


# Name first and frozen: it is what the PI scans and searches for, on a phone as much as on a laptop.
PEOPLE_PRIORITY = (
    'name', 'id', 'join_date', 'status', 'member_type', 'slack_active', 'membership_review', 'privilege_level',
    'collaborator_subgroup', 'role', 'location', 'current_city', 'timezone',
    'slack_messages_7d', 'receives_nudges', 'hours_per_week', 'affiliation',
    'calendar_group', 'last_login_at', 'compute_access', 'availability',
    'papers_authored_count', 'search',
)
# Text the 'search' column joins, so one filter or Ctrl-F hit finds a person by any of them.
PEOPLE_SEARCH_FIELDS = ('name', 'preferred_name', 'id', 'email', 'correspondence_email', 'member_type', 'role',
                        'affiliation', 'current_city', 'location', 'research_branch', 'research_topics', 'projects')
SEARCH_LIMIT = 4000


def ordered_people_columns(columns):
    """Requested columns first; retain every remaining column in its existing order."""
    if len(columns) != len(set(columns)):
        raise ValueError('Duplicate column headers')
    return [field for field in PEOPLE_PRIORITY if field in columns] + [
        field for field in columns if field not in PEOPLE_PRIORITY
    ]


def people_layout_requests(columns, sheet_id):
    """Native column moves preserve cells, formatting and references together."""
    current = list(columns)
    requests = []
    for destination, field in enumerate(ordered_people_columns(columns)):
        source = current.index(field)
        if source != destination:
            requests.append({'moveDimension': {
                'source': {'sheetId': sheet_id, 'dimension': 'COLUMNS',
                           'startIndex': source, 'endIndex': source + 1},
                'destinationIndex': destination,
            }})
            current.insert(destination, current.pop(source))
    requests.append({'updateSheetProperties': {
        'properties': {'sheetId': sheet_id, 'gridProperties': {
            'frozenRowCount': 1, 'frozenColumnCount': 1,
        }},
        'fields': 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    }})
    return requests


def cell(value):
    if value is None:
        return ''
    if isinstance(value, list):
        return ', '.join(str(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def safe_link(value):
    """https only; no embedded credentials or token-bearing query parameters."""
    if not isinstance(value, str) or not value.strip():
        return ''
    value = value.strip()
    try:
        url = urlsplit(value)
        if url.hostname in ('www.google.com', 'google.com') and url.path == '/url':
            return safe_link(dict(parse_qsl(url.query)).get('q', ''))
        if url.scheme != 'https' or not url.hostname or url.username or url.password:
            return ''
        if any(key.lower() in {'token', 'key', 'secret', 'password', 'auth', 'signature',
                              'access_token', 'id_token', 'api_key', 'apikey', 'resourcekey'}
               or key.lower().startswith(('x-amz-', 'x-goog-'))
               for key, _ in parse_qsl(url.query)):
            return ''
    except ValueError:
        return ''
    # Overleaf share/read links are exported by operator decision (2026-10-11).
    return value


def overleaf_kind(url):
    """'project' (opens only for invited collaborators), 'read' (anyone with the link can view), 'edit' (share token)."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.hostname not in ('www.overleaf.com', 'overleaf.com'):
        return None
    path = parts.path.strip('/')
    # 'project/<id>/share#<token>' is a share link: the token in the fragment lets anyone holding it join.
    if re.fullmatch(r'project/[0-9a-f]+/share', path) and re.fullmatch(r'[0-9a-f]{20,}', parts.fragment):
        return 'edit'
    if path.startswith('project/'):
        return 'project'
    if re.fullmatch(r'read/[a-z0-9]+', path):
        return 'read'
    if re.fullmatch(r'\d+[a-z0-9]+', path):
        return 'edit'
    return None


def probe_overleaf_read(url, timeout=10):
    """Asks Overleaf, logged out, whether a read link opens: 'open', 'restricted', 'busy' (rate limited) or None.

    A plain GET always returns the same page; only the token-grant call shows whether link sharing is on.
    """
    import http.cookiejar
    import urllib.error
    import urllib.request
    path = '/' + urlsplit(url).path.strip('/')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    headers = {'User-Agent': 'adminbot-sheet-export link check'}
    try:
        with opener.open(urllib.request.Request('https://www.overleaf.com' + path, headers=headers), timeout=timeout) as page:
            csrf = re.search(r'name="ol-csrfToken" content="([^"]+)"', page.read(500_000).decode('utf-8', 'replace'))
        if not csrf:
            return None
        grant = urllib.request.Request('https://www.overleaf.com' + path + '/grant', method='POST',
                                       data=json.dumps({'_csrf': csrf.group(1), 'confirmedByUser': False}).encode(),
                                       headers={**headers, 'Content-Type': 'application/json', 'Accept': 'application/json',
                                                'X-Csrf-Token': csrf.group(1)})
        with opener.open(grant, timeout=timeout) as response:
            answer = json.loads(response.read(65_536))
    except urllib.error.HTTPError as error:
        return 'busy' if error.code == 429 else None
    except (OSError, ValueError):
        return None
    if answer.get('grantAnonymousAccess') or str(answer.get('redirect', '')).startswith('/project/'):
        return 'open'
    if (answer.get('v1Import') or {}).get('status') == 'mustLogin' or answer.get('redirect') == '/restricted':
        return 'restricted'
    return None


def overleaf_access(urls, cache_path, now, probe=probe_overleaf_read, max_probes=8, budget_seconds=90):
    """{url: 'open' | 'restricted'} for Overleaf read links, cached on host by URL hash (never the token itself).

    Links that could not be checked are left out, so a network failure never reports a link as broken.
    Overleaf rate-limits after about ten logged-out checks, so each run checks a few of the stalest links
    and stops at the first refusal; open links are rechecked every three days, restricted ones daily.
    """
    import hashlib
    import time
    cache_path = Path(cache_path)
    try:
        cache = json.loads(cache_path.read_text())
    except (OSError, ValueError):
        cache = {}
    result, probes, stop = {}, 0, time.monotonic() + budget_seconds
    keyed = {url: hashlib.sha256(('/' + urlsplit(url).path.strip('/')).encode()).hexdigest()
             for url in set(urls) if overleaf_kind(url) == 'read'}
    for url in sorted(keyed, key=lambda u: ((cache.get(keyed[u]) or {}).get('checked_at', ''), u)):
        key = keyed[url]
        cached = cache.get(key) or {}
        checked = parse_time(cached.get('checked_at') or '')
        fresh = checked and now - checked < datetime.timedelta(days=3 if cached.get('status') == 'open' else 1)
        if not fresh and probes < max_probes and time.monotonic() < stop:
            if probes:
                time.sleep(3)
            probes += 1
            status = probe(url)
            if status == 'busy':
                stop = 0
            elif status:
                cached = cache[key] = {'status': status, 'checked_at': now.isoformat()}
        if cached.get('status'):
            result[url] = cached['status']
    temporary = cache_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(cache, sort_keys=True))
    temporary.replace(cache_path)
    return result


def overleaf_urls(connection):
    """Every Overleaf link the export may show, read before the export snapshot so probing never holds it open."""
    urls = []
    if connection.execute("SELECT 1 FROM sqlite_master WHERE name='adminbot_paper_slots'").fetchone():
        urls += [u for (u,) in connection.execute(
            "SELECT url FROM adminbot_paper_slots WHERE slot LIKE 'overleaf%' AND status IN ('provided','invalid')")]
        urls += [request_payload({'value_text': text}).get('url') for (text,) in connection.execute(
            "SELECT value_text FROM adminbot_paper_slots WHERE slot LIKE 'feedback\\_%' ESCAPE '\\' AND status='provided'")]
    for (raw,) in connection.execute('SELECT payload_json FROM adminbot_papers'):
        artifacts = json.loads(raw).get('artifacts') or {}
        urls += [artifacts.get(k) for k in ('overleaf_edit_url', 'overleaf_share_url', 'overleaf_view_url')]
    return sorted({safe_link(u) for u in urls if isinstance(u, str) and safe_link(u)})


def request_payload(row):
    try:
        payload = json.loads(row.get('value_text') or '{}')
    except ValueError:
        payload = {}
    return payload if isinstance(payload, dict) else {}


def pi_requests(slots, links):
    """Every way a PI review gets requested, as one list; done once PI approval is recorded after it."""
    by_slot = {row['slot']: row for row in slots}
    approval = by_slot.get('pi_approval', {})
    approved_at = parse_time(approval.get('provided_at')) if approval.get('status') == 'provided' else None
    requests = []
    for row in slots:
        if row['slot'].startswith('feedback_') and row['status'] == 'provided':
            payload = request_payload(row)
            requests.append({'type': review_type(row['slot']), 'at': parse_time(row.get('provided_at')),
                             'by': row.get('provided_by_member_id'), 'url': safe_link(payload.get('url')),
                             'note': str(payload.get('reason') or '').strip(),
                             'hard': parse_time(payload.get('hard_deadline') or ''),
                             'soft': parse_time(payload.get('soft_deadline') or '')})
    ack = by_slot.get('authors_ack', {})
    if ack.get('status') == 'provided':
        missing = [label for label, column in (('PDF', 'PDF'),) if not links[column]]
        requests.append({'type': 'Publication approval', 'at': parse_time(ack.get('provided_at')),
                         'by': ack.get('provided_by_member_id'), 'url': '', 'hard': None, 'soft': None,
                         'note': 'Authors signed off; ready for PI approval.' + (
                             ' PDF link missing or invalid.' if missing else ''),
                         'settled': approval.get('status') in ('provided', 'waived')})
    for request in requests:
        request['pending'] = not (request.get('settled') or (
            approved_at and request['at'] and approved_at >= request['at']))
    return requests, approved_at


def countdown(days):
    return ('overdue by %d day%s' % (-days, '' if days == -1 else 's') if days < 0 else
            'today' if days == 0 else 'tomorrow' if days == 1 else 'in %d days' % days)


def days_until(moment, now):
    return (moment.astimezone(TORONTO).date() - now.astimezone(TORONTO).date()).days


def urgency(hard, soft, waiting_since, now, prefix='Due', soft_name='soft target', window=None):
    """Returns (label, sort rank); rank 0 is most urgent.

    Only a hard deadline is coloured and can turn red; a missed one is ⛔. A soft target is drawn thin
    (◌), ranks one step lower and never escalates on its own; ahead of a hard deadline it is a trailing note.
    window: review days given before a dateless request counts as waiting (arXiv feedback).
    """
    note, soft_rank = '', 9
    if soft and not (hard and (soft >= hard or hard < now)):
        days = days_until(soft, now)
        passed = 'passed %d day%s ago' % (-days, '' if days == -1 else 's') if days < 0 else None
        note = f"{soft_name} {passed or countdown(days)}"
        soft_rank = 2 if days < 0 else (1 if days <= 3 else 2 if days <= 7 else 3)
    if hard:
        days = days_until(hard, now)
        icon, rank = (('⛔', 0) if days < 0 else ('🔴', 0) if days <= 3 else ('🟠', 1) if days <= 7 else
                      ('🟡', 2) if days <= 21 else ('🟢', 3))
        when = countdown(days)
        label = f'{icon} {prefix} {when}' if days >= 0 else f'{icon} {prefix.replace("Due", "Hard deadline")} {when}'
        return label + (f' · {note}' if note else ''), min(rank, soft_rank)
    if note:
        return '◌ ' + note[0].upper() + note[1:], soft_rank
    if waiting_since:
        days = (now - waiting_since).days
        if window and days < window:
            return '◌ In %d-day review window: day %d' % (window, days + 1), 3
        return ('🟠' if days >= 7 else '🟡') + (' Waiting %d days' % days if days > 1 else ' New request'), (1 if days >= 7 else 2)
    return '', 9


# The closed set of 'PI review' values, first match wins. Every paper gets exactly one; a paper none
# of these rules describes reads 'Other: <reason>' and is counted in the sheet, which is the cue to
# add a rule here rather than a value nobody filters for. Accepted / Rejected / Withdrawn come only
# from the PI's OpenReview, never from what AdminBot's record claims.
# A paper before submission needs the PI's review this long before its venue's hard deadline.
REVIEW_LEAD_DAYS = 21
# Papers whose venue deadline is this close lead the sheet, nearest deadline first, whatever their
# review status: an approved EMNLP paper still sits with the other EMNLP papers while EMNLP is near.
APPROACHING_DAYS = 30
# A paper before submission with no update for this long counts as stuck.
STUCK_DAYS = 30
PI_REVIEW_RULES = (
    ('Blocked: link access', 'A review is pending but the link sent for it does not open for the PI'),
    ('Needs PI review', 'A review request is pending and its deadline is ahead or it has none'),
    ('Accepted', 'OpenReview: accepted'),
    ('Rejected', 'OpenReview: rejected or desk rejected'),
    ('Withdrawn', 'OpenReview: withdrawn'),
    ('Submitted on OpenReview', 'OpenReview: under review, or an ARR submission settled the request'),
    ('Past deadline', 'The only pending request is ARR feedback whose cycle has closed'),
    ('Approved', 'PI approval recorded after every request; shown as "Approved <date>"'),
    ('Waiting on author', f'Before submission, a hard venue deadline within {REVIEW_LEAD_DAYS} days, nothing sent for PI review'),
    ('No PI review needed', f'Nothing requested and no deadline asks for one: past submission, or no deadline in {REVIEW_LEAD_DAYS} days'),
    ('Accepted elsewhere', 'Accepted per AdminBot at a venue the PI\'s OpenReview does not show'),
    ('Other', 'None of the above; the reason follows the colon'),
)
PI_REVIEW_VALUES = tuple(value for value, _ in PI_REVIEW_RULES)


def pi_review_status(top, requests, approved_at, review, record, stage, deadline, locked_review, now):
    """One value from PI_REVIEW_RULES for a paper (with '<date>' / '<reason>' filled in)."""
    outcome = (review or {}).get('status')
    if top and top['rank'] < 50:
        return 'Blocked: link access' if locked_review else 'Needs PI review'
    if outcome == 'accepted':
        return 'Accepted'
    if outcome in ('rejected', 'desk_rejected'):
        return 'Rejected'
    if outcome == 'withdrawn':
        return 'Withdrawn'
    if outcome == 'under_review' or any(r.get('submitted') for r in requests):
        return 'Submitted on OpenReview'
    if top:
        return 'Past deadline'
    if approved_at:
        return 'Approved ' + toronto(approved_at, False)
    if outcome:
        return f'Other: OpenReview status {outcome}'
    if record.get('venue_decision') == 'accept' or record.get('accepted_venue'):
        return 'Accepted elsewhere'
    if not stage:
        return 'Other: no stage recorded'
    if stage not in STAGES:
        return f'Other: unknown stage {stage}'
    hard = deadline and not deadline.get('soft_only') and deadline.get('at')
    if stage in PRE_SUBMISSION and not record.get('under_review') and hard and 0 <= days_until(hard, now) <= REVIEW_LEAD_DAYS:
        return 'Waiting on author'
    return 'No PI review needed'


def status_kind(status):
    """'Approved Thu Oct 1, 2026' -> 'Approved', 'Other: x' -> 'Other'."""
    # Longest first, so 'Accepted elsewhere' is not read as 'Accepted'.
    return next((value for value in sorted(PI_REVIEW_VALUES, key=len, reverse=True) if status == value
                 or value == 'Approved' and status.startswith('Approved ')), 'Other')


def due_text(request):
    hard, soft = request.get('hard'), request.get('soft')
    if hard and soft and soft < hard:
        return f'{stamp(hard)} (soft target {stamp(soft)})'
    return stamp(hard) if hard else ('Soft target ' + stamp(soft)) if soft else ''


# --------------------------------------------------------------------------
# OpenReview outcome per paper
# --------------------------------------------------------------------------
FORUM_ID_RE = re.compile(r'openreview\.net/(?:forum|pdf)\?(?:[^#]*&)?id=([A-Za-z0-9_-]+)')
OVERALL_KEYS = ('overall_assessment', 'rating', 'recommendation', 'overall_recommendation')
STATUS_TEXT = {'accepted': '✅ Accepted', 'under_review': '⏳ Under review', 'rejected': '❌ Rejected',
               'desk_rejected': '❌ Desk rejected', 'withdrawn': '↩️ Withdrawn'}
TRACK_NAMES = {'main': 'Main', 'findings': 'Findings', 'demo': 'Demo', 'workshop': 'Workshop'}


def normalized_title(title):
    return re.sub(r'[^a-z0-9]', '', str(title or '').lower())


def venue_from_id(venue_id):
    """'aclweb.org/ACL/ARR/2026/October/Submission' -> 'ARR October 2026'."""
    parts = [p for p in str(venue_id or '').split('/') if p]
    if 'ARR' in parts and len(parts) >= parts.index('ARR') + 3:
        year, month = parts[parts.index('ARR') + 1:parts.index('ARR') + 3]
        return f'ARR {month} {year}'
    # 'ICLR.cc/2027/Conference/Submission' -> 'ICLR 2027'; workshops keep their name after the year.
    year = next((i for i, p in enumerate(parts) if p.isdigit() and len(p) == 4), None)
    if not parts or year is None:
        return str(venue_id or '')
    rest = [p.replace('_', ' ') for p in parts[year + 1:] if p != 'Conference' and not p.endswith('Submission')]
    # 'aclweb.org/ACL/2026' and 'eacl.org/EACL/2027' name the venue just before the year.
    name = parts[year - 1] if year > 1 and '.' not in parts[year - 1] else parts[0].split('.')[0]
    return ' '.join([name, parts[year], *rest])


def review_venue(entry):
    """'EMNLP 2026 System Demonstration' for an OpenReview entry, from its venue id else its label."""
    return venue_from_id(entry.get('venue_id')) or entry.get('venue') or ''


def cycle_key(entry):
    """(year, month) of a submission's venue, so a resubmission beats the cycle before it."""
    words = str(entry.get('venue_id') or '').replace('/', ' ').lower().split()
    year = next((int(w) for w in words if w.isdigit() and len(w) == 4), 0)
    names = [datetime.date(2000, m, 1).strftime('%B').lower() for m in range(1, 13)]
    month = next((names.index(w) + 1 for w in words if w in names), 0)
    return year, month


def citation_check_results(connection):
    """Submissions the citation checker already saw, as a fallback when the results snapshot is missing.

    These rows say only which venue a submission sits in, so they yield nothing but "under review",
    "rejected" or "withdrawn"; decisions, presentation and scores need the snapshot.
    """
    if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='adminbot_openreview_citation_checks'").fetchone():
        return []
    entries = {}
    for submission_id, title, venue_id in connection.execute(
            'SELECT submission_id,title,venue_id FROM adminbot_openreview_citation_checks'):
        lowered = str(venue_id or '').lower()
        status = ('withdrawn' if 'withdraw' in lowered else 'desk_rejected' if 'desk_reject' in lowered
                  else 'rejected' if 'reject' in lowered else 'under_review' if lowered.endswith('/submission') else None)
        if status:
            entries[submission_id] = {'id': submission_id, 'forum': submission_id, 'title': title,
                                      'venue': venue_from_id(venue_id), 'venue_id': venue_id, 'status': status,
                                      'source': 'citation_check'}
    return list(entries.values())


TITLE_STOP_WORDS = frozenset('a an and are by do does for from how in is of on the to via what with'.split())


def title_words(title):
    """Content words, singular: 'Fluid Reasoning Representations' -> ['fluid', 'reasoning', 'representation']."""
    words = re.findall(r'[a-z0-9]+', str(title or '').lower())
    return [w[:-1] if w.endswith('s') and len(w) > 3 else w for w in words if w not in TITLE_STOP_WORDS]


def same_title(a, b):
    """Whether two titles name the same paper: equal, one cut short, or renamed keeping its subtitle or every word.

    'Do LLMs Rewrite History? Detecting Historical Revisionism in LLMs' and 'Preserving Historical
    Truth: Detecting Historical Revisionism in LLMs' share the subtitle; 'Fluid Reasoning
    Representations' keeps every word of 'Fluid Representations in Reasoning Models' it uses.
    """
    na, nb = normalized_title(a), normalized_title(b)
    if not na or not nb:
        return False
    short, long = sorted((na, nb), key=len)
    if short == long or len(short) >= 30 and long.startswith(short):
        return True
    subtitles = {normalized_title(re.split(r'[:?]', str(t), maxsplit=1)[1]) for t in (a, b) if re.search(r'[:?]\s*\w', str(t))}
    if len(subtitles) == 1 and all(re.search(r'[:?]\s*\w', str(t)) for t in (a, b)) and len(next(iter(subtitles))) >= 30:
        return True
    few, many = sorted((title_words(a), title_words(b)), key=len)
    return len(few) >= 3 and few[0] == many[0] and set(few) <= set(many)


def openreview_history(record, slots, results):
    """Every OpenReview submission of this paper, oldest cycle first.

    A forum id in any of its links, the same title, or the title its id was made from count as
    exact; a renamed or shortened title (same_title) counts only for submissions no other paper
    claims by exact title, so two papers with similar names never swap outcomes.
    """
    urls = [row.get('url') for row in slots] + list((record.get('artifacts') or {}).values())
    forums = {m.group(1) for u in urls if isinstance(u, str) for m in [FORUM_ID_RE.search(u)] if m}
    titles = {normalized_title(record.get('title')), normalized_title(record.get('id'))} - {''}
    history = {}
    for e in results:
        # The API sync lists every title a submission carried ('titles'), so a paper retitled at
        # camera-ready still matches by the title it was submitted under.
        carried = {normalized_title(t) for t in [e.get('title'), *(e.get('titles') or [])]}
        exact = forums & {e.get('id'), e.get('forum'), e.get('review_forum')} or titles & carried
        renamed = not exact and not (e.get('papers') or set()) - {record.get('id')} and any(
            same_title(record.get(field), e.get('title')) for field in ('title', 'alias') if record.get(field))
        if exact or renamed:
            history.setdefault(e.get('id') or id(e), e)
    return sorted(history.values(), key=submitted_when)


def submitted_when(entry):
    """When a submission happened, in ms: its notification date, else its cycle (a conference id names
    only its year, so it counts as that December)."""
    if entry.get('date'):
        return entry['date']
    # The API sync stamps when the submission was made; the notification path stamped 'date'.
    if entry.get('submitted_at'):
        try:
            return datetime.datetime.fromisoformat(str(entry['submitted_at']).replace('Z', '+00:00')).timestamp() * 1000
        except ValueError:
            pass
    year, month = cycle_key(entry)
    return datetime.datetime(year or 1970, month or 12, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000


def openreview_best(history):
    """The submission that says where the paper stands now.

    An acceptance at a conference (not a workshop) is where the paper ended up; otherwise the
    latest cycle wins (a rejection followed by a resubmission reads as under review), and within a
    cycle a decision or notification beats a stale citation-check row.
    """
    return max(history, key=lambda e: (e.get('status') == 'accepted' and 'workshop' not in str(e.get('venue') or '').lower(),
                                       cycle_key(e), e.get('source') != 'citation_check', e.get('date') or 0,
                                       e.get('submitted_at') or ''), default=None)


def openreview_match(record, slots, results):
    """The submission a paper refers to now (see openreview_history and openreview_best)."""
    return openreview_best(openreview_history(record, slots, results))


def history_text(history, best):
    """'❌ ICML 2026 → ⏳ ARR May 2026 → ✅ EMNLP 2026' when a paper went to more than one venue, else ''."""
    venues = {}
    for e in history:
        venue = e.get('venue') or venue_from_id(e.get('venue_id'))
        if venue.lower() == 'openreview.net archive':
            continue
        kept = venues.get(venue)
        if not kept or kept.get('source') == 'citation_check' or e is best:
            venues[venue] = e
    if len(venues) < 2:
        return ''
    marks = {'accepted': '✅', 'under_review': '⏳', 'rejected': '❌', 'desk_rejected': '❌ desk', 'withdrawn': '↩️'}
    return ' → '.join(f"{marks.get(e.get('status'), '?')} {venue}" for venue, e in venues.items())


def arr_cycle_deadline(entry, cycles):
    """Deadline of the ARR cycle an OpenReview submission went to ('.../ARR/2026/October/...'), else None.

    A venue commitment counts as the ARR cycle it was committed from.
    """
    parts = str((entry or {}).get('arr_venue_id') or (entry or {}).get('venue_id') or '').split('/')
    if 'ARR' not in parts or len(parts) < parts.index('ARR') + 3:
        return None
    year, month = parts[parts.index('ARR') + 1:parts.index('ARR') + 3]
    return cycles.get(f'{month[:3].capitalize()} {year}')


def same_venue(record, venue):
    """Whether the record's acceptance is at this OpenReview venue: same series, and same year when both say."""
    accepted = str(record.get('accepted_venue') or '')
    series = re.findall(r'[a-z]+', accepted.lower())[:1]
    year = str(record.get('accepted_year') or (re.search(r'\b20\d{2}\b', accepted) or [''])[0])
    venue_year = (re.search(r'\b20\d{2}\b', venue) or [''])[0]
    return bool(series) and venue.lower().startswith(series[0]) and (not year or not venue_year or year == venue_year)


def as_on_openreview(record, review, history=()):
    """The paper's venue and decision as the PI's OpenReview has them.

    OpenReview is the ground truth for what came of a submission: an acceptance there sets the
    venue, year and track; a rejection, desk rejection or withdrawal there clears an acceptance the
    record claims at that same venue; a submission under review there names the venue and means
    the paper is past submitting. An acceptance elsewhere stands (a workshop paper resubmitted to
    a conference, or accepted at a venue not on OpenReview), and so does one from a later year than
    the OpenReview submission. The record keeps its own venue after a rejection: that is the next plan.
    A rejection anywhere in the paper's history at the venue the record calls accepted also clears it
    (desk-rejected at EMNLP, then resubmitted to ARR, is not an EMNLP paper).
    """
    if not review or not review.get('status'):
        return record
    if review['status'] != 'accepted' and any(e.get('status') in ('rejected', 'desk_rejected', 'withdrawn')
                                              and same_venue(record, review_venue(e)) for e in history):
        record = dict(record, venue_decision='reject', accepted_venue=None, accepted_year=None)
    venue = review_venue(review)
    year = (re.search(r'\b20\d{2}\b', venue) or [''])[0]
    accepted = record.get('venue_decision') == 'accept' or (
        bool(record.get('accepted_venue')) and record.get('venue_decision') != 'reject')
    if accepted and str(record.get('accepted_year') or '') > year:
        return record
    record = dict(record, artifacts=dict(record.get('artifacts') or {}))
    if review['status'] == 'accepted':
        record.update(venue_decision='accept', accepted_venue=venue, accepted_year=year)
        if review.get('track'):
            record['artifacts']['publication_track'] = review['track']
    elif review['status'] == 'under_review':
        record.update(venue=venue, under_review=True)
        if not accepted:
            record.update(venue_decision=None, accepted_venue=None, accepted_year=None)
    elif not accepted or same_venue(record, venue):
        record.update(venue_decision='reject', accepted_venue=None, accepted_year=None)
    return record


def with_adminbot_decision(record, review):
    """An AdminBot acceptance at the venue OpenReview still lists as under review: the decision mail went
    to another author (demo and workshop tracks often mail only the submitter), so the paper is accepted."""
    if not review or review.get('status') != 'under_review' or record.get('venue_decision') != 'accept' or (
            not same_venue(record, review_venue(review))):
        return review
    track = review.get('track') or (record.get('artifacts') or {}).get('publication_track') or None
    return dict(review, status='accepted', track=track, decided_by='AdminBot')


def accepted_text(record, review):
    """'EMNLP 2026 · Findings · Poster' for an accepted paper, else ''."""
    if record.get('venue_decision') != 'accept' and not record.get('accepted_venue'):
        return ''
    name, year = str(record.get('accepted_venue') or ''), str(record.get('accepted_year') or '')
    parts = [name + (' ' + year if year and year not in name else '')]
    if (record.get('artifacts') or {}).get('publication_track') == 'findings' and 'findings' not in name.lower():
        parts.append('Findings')
    if review and review.get('status') == 'accepted' and review.get('presentation') and (
            review['presentation'] not in name.lower()):
        parts.append(review['presentation'].capitalize())
    return ' · '.join(p for p in parts if p.strip())


# What the paper is, one value each so the sheet filters the same way for every conference.
TRACKS = ('Main', 'Findings', 'Workshop', 'Demo', 'Industry', 'Tutorial', 'Journal')
PRESENTATIONS = ('oral', 'spotlight', 'poster')


def track_of(record, review, *texts):
    """'Workshop' / 'Demo' when the venue says so, else the track OpenReview or AdminBot gives; an accepted
    paper with nothing else known is Main."""
    text = ' '.join(str(t or '') for t in texts).lower()
    if 'workshop' in text:
        return 'Workshop'
    if re.search(r'\bdemo|system[ _]demonstration', text):
        return 'Demo'
    # AdminBot's track describes an acceptance; once OpenReview clears that, it no longer applies.
    accepted = (review or {}).get('status') == 'accepted' or record.get('venue_decision') == 'accept'
    track = (review or {}).get('track') or (accepted and (record.get('artifacts') or {}).get('publication_track'))
    if track in TRACK_NAMES:
        return TRACK_NAMES[track]
    named = next((t for t in ('Findings', 'Industry', 'Tutorial', 'Journal') if t.lower() in text), '')
    return named or ('Main' if accepted else '')


def presentation_of(record, review):
    """'Oral' / 'Spotlight' / 'Poster' for an accepted paper: OpenReview's decision, else AdminBot's record."""
    if (review or {}).get('status', 'accepted') != 'accepted' or record.get('venue_decision') != 'accept':
        return ''
    for value in ((review or {}).get('presentation'), record.get('presentation_type')):
        if str(value or '').lower() in PRESENTATIONS:
            return str(value).capitalize()
    return ''


def year_of(record, *texts):
    """The paper's conference year: the first 20xx in the accepted, OpenReview or typed venue, else AdminBot's."""
    found = next((m.group(0) for t in texts for m in [re.search(r'\b20\d{2}\b', str(t or ''))] if m), '')
    return found or str(record.get('accepted_year') or '')


def source_of(review, typed, matched):
    """Where Conference and the decision come from, flagging a typed venue OpenReview contradicts."""
    if not review:
        return 'AdminBot' if typed != 'Not set' else ''
    source = 'OpenReview + AdminBot decision' if review.get('decided_by') else 'OpenReview'
    if typed not in UNNAMED_CONFERENCES and matched not in UNNAMED_CONFERENCES and typed != matched:
        source += f' (AdminBot venue says {typed})'
    return source


# The closed set of 'Paper state' values, first match wins: where the paper stands, separate from
# whether the PI owes a review. OpenReview decides every outcome; AdminBot fills in before submission.
PAPER_STATE_RULES = (
    ('Camera-ready due', 'Accepted and a camera-ready deadline is still ahead'),
    ('Accepted', 'Accepted on OpenReview, or per AdminBot at a venue OpenReview does not show'),
    ('Resubmitted after rejection', 'Under review on OpenReview after a rejection, desk rejection or withdrawal'),
    ('Under review (no PI review)', 'Under review on OpenReview and nothing was ever sent to the PI'),
    ('Under review', 'Under review on OpenReview, or AdminBot says it was submitted'),
    ('Desk rejected', 'OpenReview: desk rejected, not resubmitted since'),
    ('Rejected', 'OpenReview: rejected, not resubmitted since'),
    ('Withdrawn', 'OpenReview: withdrawn, not resubmitted since'),
    ('Needs PI review', 'Not yet submitted and a PI review is pending or blocked'),
    ('On arXiv', 'Not submitted anywhere, with an arXiv link'),
    ('arXiv planned', 'In arXiv polish'),
    ('Not started', 'No stage yet, or brainstorming'),
    ('Writing', 'Writing in Overleaf or preparing the submission'),
    ('Unknown', 'Past submission with no venue outcome anywhere: ask the lead'),
)
PAPER_STATE_VALUES = tuple(value for value, _ in PAPER_STATE_RULES)


def paper_state(record, review, history, requests, status, stage, deadline, links, now):
    """One value from PAPER_STATE_RULES for a paper."""
    outcome = (review or {}).get('status')
    accepted = outcome == 'accepted' or record.get('venue_decision') == 'accept' or bool(record.get('accepted_venue'))
    if accepted:
        camera = deadline and 'camera' in deadline_name(deadline).lower() and deadline['at'] >= now
        return 'Camera-ready due' if camera else 'Accepted'
    if outcome == 'under_review':
        if any(e.get('status') in ('rejected', 'desk_rejected', 'withdrawn') and cycle_key(e) <= cycle_key(review)
               for e in history if e is not review):
            return 'Resubmitted after rejection'
        return 'Under review' if requests else 'Under review (no PI review)'
    if outcome in ('desk_rejected', 'rejected', 'withdrawn'):
        return {'desk_rejected': 'Desk rejected', 'rejected': 'Rejected', 'withdrawn': 'Withdrawn'}[outcome]
    if record.get('under_review'):
        return 'Under review'
    if status_kind(status) in ('Needs PI review', 'Blocked: link access'):
        return 'Needs PI review'
    if links.get('arXiv'):
        return 'On arXiv'
    if stage == 'arxiv_polish':
        return 'arXiv planned'
    if not stage or stage == 'brainstorming_docs':
        return 'Not started'
    if stage in PRE_SUBMISSION:
        return 'Writing'
    return 'Unknown'


def overall(scores):
    return next((scores[k] for k in OVERALL_KEYS if k in (scores or {})), None)


def number(value):
    return f'{value:g}'


def openreview_text(entry):
    """'✅ Accepted · Findings · Poster · EMNLP 2026 · reviews 3 · 3.5 · 4 (avg 3.5) · meta 3.5'."""
    if not entry:
        return ''
    status = entry.get('status') or 'under_review'
    parts = [STATUS_TEXT.get(status, status)]
    if entry.get('track') in ('findings', 'demo', 'workshop'):
        parts.append(TRACK_NAMES[entry['track']])
    elif entry.get('track') == 'main' and status == 'accepted':
        parts.append('Main')
    if entry.get('presentation'):
        parts.append({'oral': '🎤 Oral', 'spotlight': '✨ Spotlight'}.get(entry['presentation'], 'Poster'))
    venue = entry.get('venue') or venue_from_id(entry.get('venue_id'))
    if venue and not venue.lower().startswith('submitted to'):
        parts.append(venue)
    elif venue:
        parts.append(venue[len('submitted to'):].strip())
    scores = [s for s in (overall(r) for r in entry.get('reviews') or []) if s is not None]
    if scores:
        parts.append('reviews ' + ' · '.join(number(s) for s in scores) +
                     f' (avg {number(round(sum(scores) / len(scores), 2))})')
    meta = overall(entry.get('meta_review'))
    if meta is not None:
        parts.append(f'meta {number(meta)}')
    if entry.get('error'):
        parts.append("(reviews couldn't be read)")
    if entry.get('decided_by'):
        parts.append(f"(decision from {entry['decided_by']}; not in the PI's OpenReview mail)")
    return ' · '.join(parts)


def load_openreview_results(path):
    """Submissions from the OpenReview results snapshot; [] when it is absent or unreadable."""
    try:
        return [e for e in json.loads(Path(path).read_text()).get('submissions', []) if isinstance(e, dict)]
    except (OSError, ValueError, AttributeError):
        return []


def paper_row(record, members, slots, deadlines, now, access=None, openreview=()):
    artifacts = record.get('artifacts') or {}
    by_slot = {row['slot']: row for row in slots}
    links = {}
    for column, (artifact_keys, slot_names) in PAPER_LINKS.items():
        # Invalid slots still count for Overleaf: they were rejected only for being share/read links.
        candidates = [by_slot[s].get('url') for s in slot_names if s in by_slot and (
            by_slot[s]['status'] == 'provided' or (by_slot[s]['status'] == 'invalid' and s.startswith('overleaf')))]
        candidates += [artifacts.get(key) for key in artifact_keys]
        links[column] = next((safe_link(u) for u in candidates if safe_link(u)), '')
    # Overleaf links the PI cannot open: project URLs need an invitation; read links fail once sharing is off.
    access = access or {}
    locked = {column: ('project link opens only for people invited to the project' if overleaf_kind(url) == 'project'
                       else 'read link does not open (link sharing is off or the link was reset)')
              for column, url in links.items() if url and (overleaf_kind(url) == 'project' or access.get(url) == 'restricted')}
    requests, approved_at = pi_requests(slots, links)
    history = openreview_history(record, slots, openreview)
    review = openreview_best(history)
    stage = record.get('current_step')
    record = as_on_openreview(record, review, history)
    if with_adminbot_decision(record, review) is not review:
        review = with_adminbot_decision(record, review)
        record = as_on_openreview(record, review, history)
    venue, deadline = venue_info(record, slots, deadlines, now)
    venue = venue or VENUE_NOTES.get(record['id'], '')
    cycles = arr_calendar(deadlines)[0]
    submitted_cycle = arr_cycle_deadline(review, cycles)
    for request in requests:
        # The paper sits on the PI's OpenReview in an ARR cycle that closed after this request: she
        # already saw it before it went in, so the request is done.
        if request['pending'] and request['type'] == 'ARR feedback' and submitted_cycle and request['at'] and (
                submitted_cycle >= request['at'] - datetime.timedelta(days=1)):
            request['pending'], request['submitted'] = False, True
        # ARR / camera-ready feedback without its own dates is due by the paper's ARR cycle or camera-ready deadline.
        inherited = deadline and not deadline.get('soft_only') and not (request['hard'] or request['soft']) and (
            request['type'] == 'ARR feedback' and 'camera' not in deadline_name(deadline).lower()
            or request['type'] == 'Camera-ready feedback' and 'camera' in deadline_name(deadline).lower())
        if inherited:
            request['hard'] = deadline['at']
        # Sort by the next date that still lies ahead: an upcoming soft target before its hard deadline comes first.
        upcoming_soft = request['soft'] and request['soft'] >= now and not (request['hard'] and request['soft'] >= request['hard'])
        request['effective_due'] = request['soft'] if upcoming_soft else request['hard'] or request['soft']
        request['label'], request['rank'] = urgency(
            request['hard'], request['soft'], request['at'], now,
            'ARR deadline' if inherited and request['type'] == 'ARR feedback' else 'Camera-ready' if inherited else 'Due',
            window=ARXIV_REVIEW_DAYS if request['type'] == 'arXiv feedback' else None)
        # ARR feedback whose deadline went by (its own date, else an ARR cycle that closed since it
        # was asked) can no longer change that submission: still listed, but below live work.
        due = max((d for d in (request['hard'], request['soft']) if d), default=None)
        closed = due if due and due < now else None if due else max(
            (at for at in cycles.values() if request['at'] and request['at'] <= at < now), default=None)
        if request['type'] == 'ARR feedback' and closed:
            request['label'], request['rank'] = f"⌛ ARR deadline passed {toronto(closed, False)}", 50
    far = datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
    priority = lambda r: REVIEW_PRIORITY.index(r['type']) if r['type'] in REVIEW_PRIORITY else len(REVIEW_PRIORITY)
    pending = sorted((r for r in requests if r['pending']),
                     key=lambda r: (r['rank'], r['effective_due'] or far, priority(r), r['at'] or now))
    top = pending[0] if pending else None
    if top:
        label, rank = top['label'], top['rank']
    else:
        deadline = deadline or {}
        soft = deadline if deadline.get('soft_only') else deadline.get('soft')
        label, rank = urgency(None if deadline.get('soft_only') else deadline.get('at'), soft and soft['at'], None, now,
                              'Camera-ready' if 'camera' in (deadline.get('label') or '').lower() else 'Venue deadline',
                              (soft or {}).get('label', '').lower() or 'early deadline')
        deadline = deadline or None
        rank = 10 + rank if label and rank <= 2 else 99
        label = label if rank < 99 else ''
    # Every link in one cell, most useful first, each under its real name. The request's own link
    # leads as 'Sent for review' only when it is not already one of the paper's links.
    review_links = []
    for column, url in links.items():
        if url and url not in {u for _, u in review_links}:
            review_links.append((column, url))
    if top and top['url'] and top['url'] not in {u for _, u in review_links}:
        review_links.insert(0, ('Sent for review', top['url']))
        if overleaf_kind(top['url']) == 'project' or access.get(top['url']) == 'restricted':
            locked['Sent for review'] = locked.get('Sent for review') or (
                'project link opens only for people invited to the project' if overleaf_kind(top['url']) == 'project'
                else 'read link does not open (link sharing is off or the link was reset)')
    review_links = [(label + ' 🔒' if label in locked else label, url) for label, url in review_links]
    # An invite-only project link is a problem only when no Overleaf link the PI can open sits beside it.
    can_open = any(overleaf_kind(url) and label not in locked for label, url in links.items() if url)
    link_problems = [f"{slot_label(r['slot'])}: {r.get('invalid_reason') or 'invalid'}" for r in slots
                     if r['status'] == 'invalid' and not links.get(LINK_OF_SLOT.get(r['slot']))]
    link_problems += [f'{label}: {problem}' for label, problem in locked.items()
                      if not (can_open and problem.startswith('project'))]
    # The review is blocked when the link it was sent with (else every Overleaf link) is one the PI
    # cannot open and no other Overleaf link of the paper opens instead.
    locked_urls = {links.get(c) for c in locked} | ({top['url']} if top and 'Sent for review' in locked else set())
    locked_review = bool(top) and (
        top['url'] in locked_urls and not (can_open and overleaf_kind(top['url'])) if top['url']
        else bool(locked) and not can_open)
    status = pi_review_status(top, requests, approved_at, review, record, stage, deadline, locked_review, now)
    updated = parse_time(record.get('updated_at') or '')
    incomplete = []
    if status.startswith('Blocked:'):
        incomplete.append('PI cannot open the link sent for review')
    if link_problems:
        incomplete.append('Fix link' + ('s' if len(link_problems) > 1 else '') + ': ' + '; '.join(link_problems))
    if stage in PRE_SUBMISSION and status_kind(status) in ('Waiting on author', 'No PI review needed') and updated and (
            now - updated).days >= STUCK_DAYS:
        incomplete.append(f'Stuck: no update for {(now - updated).days} days in {STAGES[stage]}')
    if status_kind(status) == 'Other':
        incomplete.append('Status unclassified: ' + status.partition(': ')[2])
    typed_conference = conference(venue, record.get('venue') or artifacts.get('conference') or '')
    matched_conference = conference(review_venue(review)) if review else 'Not set'
    accepted = accepted_text(record, review)
    owner_id = record.get('lead_owner_member_id')
    name = lambda member_id: members.get(member_id, {}).get('name', member_id or '')
    row = {
        'Paper': record.get('title', ''),
        'Urgency': label,
        'PI review': status,
        'Paper state': paper_state(record, review, history, requests, status, stage, deadline, links, now),
        'Review for': ', '.join(dict.fromkeys(r['type'] for r in pending)) if pending else (
            ', '.join(dict.fromkeys(r['type'] for r in requests)) if requests else ''),
        'Review link': review_links,
        'Due (Toronto)': due_text(top) if top else '',
        'Requested by': name(top['by']) if top else '',
        'Requested on': stamp(top['at'], False) if top else '',
        'Request note': '\n\n'.join(f"[{r['type']}] {r['note']}" for r in pending if r['note']),
        'Venue': venue,
        # OpenReview names the conference whenever it knows the paper; the typed venue fills the rest.
        'Conference': typed_conference if matched_conference in UNNAMED_CONFERENCES else matched_conference,
        'Year': year_of(record, accepted, review_venue(review) if review else '', venue, record.get('venue')),
        'Track': track_of(record, review, accepted, review_venue(review) if review else '',
                          '' if review else venue),
        'Presentation': presentation_of(record, review),
        'Venue deadline (Toronto)': '\n'.join(f"{stamp(d['at'])} · {deadline_name(d)}" for d in (
            deadline.get('soft'), deadline) if d) if deadline else '',
        'Venue (as entered)': ' '.join(str(record.get('venue') or artifacts.get('conference') or '').split()),
        'OpenReview': openreview_text(review),
        'Submission history': history_text(history, review),
        'Source': source_of(review, typed_conference, matched_conference),
        'Stage': STAGES.get(stage, stage or ''),
        'Lead': record.get('lead_owner') or name(owner_id),
        'Incomplete': '\n'.join(incomplete),
        'Blocker / next step': '\n'.join(str(x) for x in [artifacts.get('blocker_title'), artifacts.get('blocker_note'),
                                                         record.get('next_action')] if x),
        'Link problems': '\n'.join(link_problems),
        'Still missing': ', '.join(sorted(slot_label(r['slot']) for r in slots if r['status'] == 'missing')),
        'Mentor review': by_slot.get('papermentor_review', {}).get('status', ''),
        'Co-author feedback': by_slot.get('coauthor_feedback', {}).get('status', ''),
        'Accepted': accepted,
        'Going to conference': record.get('going_attendees', ''),
        'Started': record.get('started_on', ''),
        'Last updated': stamp(parse_time(record.get('updated_at') or ''), False),
        'Feedback givers': record.get('feedback_givers', ''),
        'Checks': ', '.join(f'{k}: {v}' for k, v in sorted((record.get('checks') or {}).items())),
        'Authors': record.get('authors', ''),
        'All artifact statuses': '\n'.join(sorted(f"{r['slot']}: {r['status']}" for r in slots)),
        PAPER_ID: record['id'],
    }
    row['_link_problems'] = link_problems
    upcoming = [d['at'] for d in ((deadline or {}).get('soft'), deadline) if d and d['at'] >= now]
    approaching = bool(upcoming) and min(upcoming) <= now + datetime.timedelta(days=APPROACHING_DAYS)
    # Blocked reviews float to the top of their group: the PI cannot act until someone fixes the link.
    row['_sort'] = (0 if approaching else 1, deadline['at'] if approaching else now, row['Conference'] if approaching else '',
                    0 if status.startswith('Blocked:') else 1,
                    0 if top and rank < 50 else 1, rank, (top or {}).get('effective_due') or (deadline or {}).get('at') or far,
                    priority(top) if top else 0, (top or {}).get('at') or now, -(updated.timestamp() if updated else 0), row['Paper'], record['id'])
    return row


def published_deadlines(connection):
    if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='adminbot_published_deadlines'").fetchone():
        return []
    latest = {}
    for deadline_id, revision, raw in connection.execute(
            'SELECT deadline_id, revision, payload_json FROM adminbot_published_deadlines'):
        if deadline_id not in latest or revision > latest[deadline_id][0]:
            latest[deadline_id] = (revision, json.loads(raw).get('deadline') or {})
    result = []
    for _, d in latest.values():
        try:
            local = datetime.datetime.fromisoformat(f"{d['deadlineDate']}T{d.get('deadlineTime') or '23:59'}")
            at = local.replace(tzinfo=ZoneInfo(d.get('timezone') or 'Etc/GMT+12'))
        except (KeyError, ValueError):
            continue
        stage = d.get('stage') if isinstance(d.get('stage'), dict) else {}
        result.append({'name': d.get('name', ''), 'conference': d.get('parentConference') or d.get('name', '').split()[0],
                       'year': str(d.get('parentYear') or ''), 'type': d.get('entryType', ''), 'at': at,
                       'milestone': str(stage.get('milestone') or ''), 'label': str(stage.get('label') or '')})
    return result


def normalized_join_date(value):
    value = str(value or '').strip()
    for pattern, precision in (('%Y-%m-%d', 'day'), ('%Y-%m', 'month'),
                               ('%b-%y', 'month'), ('%B %Y', 'month'),
                               ('%b %Y', 'month'), ('%Y', 'year')):
        try:
            date = datetime.datetime.strptime(value, pattern).date()
            if not 1900 <= date.year <= datetime.date.today().year + 1:
                continue
            return date.strftime({'day': '%Y-%m-%d', 'month': '%Y-%m', 'year': '%Y'}[precision])
        except ValueError:
            pass
    # A numeric slash date is safe only when both locale interpretations agree.
    try:
        us = datetime.datetime.strptime(value, '%m/%d/%Y').date()
        uk = datetime.datetime.strptime(value, '%d/%m/%Y').date()
        if us == uk and 1900 <= us.year <= datetime.date.today().year + 1:
            return us.isoformat()
    except ValueError:
        pass
    return ''


def people_sort_key(record):
    value = normalized_join_date(record.get('join_date') or record.get('joined_month'))
    # Preserve source precision; this padding is used only for chronological sorting.
    return (0 if value else 1, value + {4: '-00-00', 7: '-00'}.get(len(value), ''),
            str(record.get('name', '')).casefold(), record['id'])


def people_review_fields(record):
    channels = record.get('slack_channels')
    # Stored channel evidence is not a presence signal or a fresh Slack read.
    active = 'Unknown'
    if record.get('slack_user_id') and isinstance(channels, list) and all(isinstance(c, str) for c in channels):
        active = 'Recorded yes' if any(str(c).lstrip('#').casefold() == 'jinesis-active' for c in channels) else 'Recorded no'
    status = str(record.get('status') or '').casefold()
    return {'slack_active': active, 'membership_review':
            'Review inactive' if status in ('inactive', 'alumni', 'removed') or 'alumni' in {token.strip() for token in str(record.get('member_type', '')).replace('_', '-').split(',')} else
            'Status unknown' if not status else 'Recorded ' + status}


def people_search_text(record, papers):
    """Name, aliases, contacts, topics, projects and authored papers with venues, deduplicated, in one cell."""
    parts = [cell(record.get(field)) for field in PEOPLE_SEARCH_FIELDS]
    parts += [' '.join(filter(None, (cell(p.get('title')), cell(p.get('venue'))))) for p in papers]
    seen, terms = set(), []
    for part in parts:
        part = ' '.join(part.split())
        if part and part.casefold() not in seen:
            seen.add(part.casefold())
            terms.append(part)
    return ' | '.join(terms)[:SEARCH_LIMIT]


def full_people_values(connection, members, papers, timestamp):
    """Export recorded fields and ID-linked aggregates; never read auth secrets."""
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    records = {record['id']: dict(record) for record in members}

    def read(table, fields):
        if table not in tables:
            return []
        return [dict(zip(fields, row)) for row in connection.execute(
            f"SELECT {','.join(fields)} FROM {table}")]

    for record in records.values():
        avatar = record.get('avatar_url', '')
        if isinstance(avatar, str) and avatar.startswith('data:image/') and len(avatar) > 50000:
            record['avatar_url'] = '[Embedded profile image omitted: exceeds Google Sheets cell limit]'
        raw_join_date = record.get('join_date') or record.get('joined_month', '')
        record['join_date'] = normalized_join_date(raw_join_date)
        record.update(people_review_fields(record))
        record['join_date_basis'] = ('Needs review: ' + str(raw_join_date)) if raw_join_date and not record['join_date'] else record.get('join_date_basis', 'joined_month' if record.get('joined_month') else '')
        onboarding = record.get('onboarding') or {}
        if onboarding:
            for source, target in [('steps', 'steps_total'), ('completed', 'completed_count'), ('remaining', 'remaining_count')]:
                if source in onboarding:
                    record['onboarding_' + target] = len(onboarding[source])
            for source in ['completed', 'remaining']:
                record['onboarding_' + source + '_ids'] = [step.get('id', '') for step in onboarding.get(source, [])]
            record['onboarding_current_step'] = (onboarding.get('current_step') or {}).get('id', '')
            for field in ['last_nudged_at', 'opened_at', 'reason']:
                record['onboarding_' + field] = onboarding.get(field, '')
        # ponytail: per-member paper scan; index explicit author IDs if export runtime grows.
        authored = [p['id'] for p in papers if any(link.get('member_id') == record['id'] for link in p.get('author_links', []))]
        submitted = [p['id'] for p in papers if p.get('submitted_by_member_id') == record['id']]
        record.update(papers_authored=authored, papers_authored_count=len(authored),
                      papers_submitted=submitted, papers_submitted_count=len(submitted))
        record['search'] = people_search_text(record, [p for p in papers if p['id'] in authored])

    # Missing tables stay unknown; zero is only used when the table exists.
    for table, key, output in [
        ('adminbot_password_resets', 'member_id', 'password_resets'),
        ('adminbot_feedback', 'member_id', 'feedback_submitted'),
        ('adminbot_tab_visits', 'member_id', 'tab_visits_count'),
        ('adminbot_logistics_requests', 'member_id', 'logistics_requests'),
        ('adminbot_paper_weekly_updates', 'member_id', 'paper_weekly_updates'),
        ('adminbot_paper_conference_attendees', 'member_id', 'conference_attendances'),
        ('adminbot_paper_slots', 'provided_by_member_id', 'paper_slots_provided'),
        ('adminbot_paper_slots', 'waived_by_member_id', 'paper_slots_waived'),
        ('adminbot_badge_nominations', 'member_id', 'badge_nominations'),
        ('adminbot_audit_events', 'actor', 'audit_events_as_actor'),
        ('adminbot_update_events', 'member_id', 'update_events_as_actor'),
        ('adminbot_update_events', 'subject_member_id', 'update_events_as_subject'),
    ]:
        if table in tables:
            counts = Counter(row[key] for row in read(table, [key]))
            for member_id, record in records.items():
                record[output] = counts[member_id]

    for row in read('adminbot_member_credentials', ['member_id', 'email', 'claimed_at', 'updated_at']):
        if row['member_id'] in records:
            records[row['member_id']].update(login_account_email=row['email'],
                login_account_claimed_at=row['claimed_at'], login_account_updated_at=row['updated_at'])
    for row in sorted(read('adminbot_account_registrations', ['member_id', 'status', 'created_at', 'decided_at']), key=lambda row: row['created_at'] or ''):
        if row['member_id'] in records:
            records[row['member_id']].update(registration_status=row['status'], registration_decided=row['decided_at'])

    for table, fields, prefix, timefield in [
        ('adminbot_login_events', ['member_id', 'at', 'country', 'continent', 'city', 'timezone'], 'login', 'at'),
        ('adminbot_member_locations', ['member_id', 'observed_at'], 'location', 'observed_at'),
        ('adminbot_cv_changes', ['member_id', 'detected_at', 'recency'], 'cv_changes', 'detected_at'),
        ('adminbot_member_notifications', ['member_id', 'created_at', 'read_at', 'kind'], 'notifications', 'created_at'),
        ('adminbot_badge_assignments', ['member_id', 'badge_id'], 'badge', None),
        ('adminbot_nudge_ledger', ['member_id', 'nudge_count'], 'nudges', None),
    ]:
        if table not in tables:
            continue
        grouped = defaultdict(list)
        for row in read(table, fields):
            grouped[row['member_id']].append(row)
        for member_id, record in records.items():
            rows = grouped[member_id]
            if timefield:
                rows.sort(key=lambda row: row[timefield] or '')
            last = rows[-1] if rows else {}
            if prefix == 'login':
                record.update(login_count=len(rows), login_first_at=rows[0]['at'] if rows else '',
                    login_last_at=last.get('at', ''), login_last_place=', '.join(filter(None, [last.get('city'), last.get('country')])),
                    login_countries_seen=sorted({row['country'] for row in rows if row['country']}),
                    login_cities_seen=sorted({row['city'] for row in rows if row['city']}))
                if rows:
                    record['last_login_at'] = last['at']
                    for field in ['country', 'continent', 'city', 'timezone']:
                        record['last_login_' + field] = last[field]
            elif prefix == 'location':
                record.update(location_observations=len(rows), location_last_observed=last.get('observed_at', ''))
            elif prefix == 'cv_changes':
                record.update(cv_changes_count=len(rows), cv_changes_last=last.get('detected_at', ''),
                    cv_changes_recency=dict(Counter(row['recency'] for row in rows)))
            elif prefix == 'notifications':
                record.update(notifications_total=len(rows), notifications_unread=sum(not row['read_at'] for row in rows),
                    notifications_last_at=last.get('created_at', ''), notification_kinds=sorted({row['kind'] for row in rows}))
            elif prefix == 'badge':
                record.update(badges=sorted({row['badge_id'] for row in rows}), badge_count=len(rows))
            elif prefix == 'nudges':
                record['nudges_count'] = sum(row['nudge_count'] for row in rows)
    if 'adminbot_sessions' in tables:
        counts = dict(connection.execute('SELECT member_id, count(*) FROM adminbot_sessions WHERE revoked_at IS NULL AND datetime(expires_at)>datetime(?) GROUP BY member_id', (timestamp,)))
        for member_id, record in records.items():
            record['active_sessions'] = counts.get(member_id, 0)
    columns = ordered_people_columns(PEOPLE_COLUMNS)
    return [columns, *[[cell(record.get(field)) for field in columns] for record in sorted(records.values(), key=people_sort_key)]]


def order_people_values(values):
    """Reorder an existing full export without dropping computed columns or rows."""
    if not values or not values[0] or 'id' not in values[0]:
        raise ValueError('People export needs a header with id')
    headers = values[0]
    ordered = ordered_people_columns(headers)
    indexes = [headers.index(field) for field in ordered]
    if any(len(row) > len(headers) for row in values[1:]):
        raise ValueError('People row exceeds header width')
    return [ordered, *[
        [cell(row[index]) if index < len(row) else '' for index in indexes]
        for row in values[1:]
    ]]


def snapshot(connection, timestamp, people_values=None, full_people=False, link_access=None, openreview=None):
    """Read both tables in one snapshot; never infer active status from missing data."""
    data = []
    records = {}
    connection.execute('BEGIN')
    try:
        going_by_paper = defaultdict(dict)
        if connection.execute("SELECT 1 FROM sqlite_master WHERE name='adminbot_paper_conference_attendees'").fetchone():
            for paper_id, attendee_key, member_id, name in connection.execute(
                    "SELECT paper_id,attendee_key,member_id,name FROM adminbot_paper_conference_attendees WHERE attending='yes'"):
                going_by_paper[paper_id][member_id or attendee_key] = name
        slots_by_paper = defaultdict(list)
        if connection.execute("SELECT 1 FROM sqlite_master WHERE name='adminbot_paper_slots'").fetchone():
            placeholders = ','.join('?' for _ in LINK_SLOTS)
            # url only for link slots; value_text only for feedback requests (never e.g. arxiv_paper_password).
            for paper_id, slot, status, provided_at, by, reason, url, text in connection.execute(
                    f"""SELECT paper_id,slot,status,provided_at,provided_by_member_id,invalid_reason,
                               CASE WHEN slot IN ({placeholders}) THEN url ELSE NULL END,
                               CASE WHEN slot LIKE 'feedback\\_%' ESCAPE '\\' THEN value_text ELSE NULL END
                        FROM adminbot_paper_slots""", LINK_SLOTS):
                slots_by_paper[paper_id].append({'slot': slot, 'status': status, 'provided_at': provided_at,
                                                 'provided_by_member_id': by, 'invalid_reason': reason,
                                                 'url': url, 'value_text': text})
        deadlines = published_deadlines(connection)
        openreview = list(openreview or []) + citation_check_results(connection)
        claims = defaultdict(set)
        for (raw,) in connection.execute('SELECT payload_json FROM adminbot_papers'):
            paper = json.loads(raw)
            for key in {normalized_title(paper.get('title')), normalized_title(paper.get('id'))} - {''}:
                claims[key].add(paper['id'])
        openreview = [dict(e, papers=claims.get(normalized_title(e.get('title')), set())) for e in openreview]
        now = parse_time(timestamp) or datetime.datetime.now(datetime.timezone.utc)
        paper_links = None
        link_problems, status_counts = {}, Counter()
        for table, tab, fields in (
            ('adminbot_lab_members', 'PeopleList', ordered_people_columns(PEOPLE)),
            ('adminbot_papers', 'PaperList', PAPERS),
        ):
            rows = []
            records[tab] = []
            member_index = {m['id']: m for m in records.get('PeopleList', [])}
            for (raw,) in connection.execute(f'SELECT payload_json FROM {table} ORDER BY id'):
                record = json.loads(raw)
                records[tab].append(record)
                if tab == 'PaperList':
                    record['going_attendees'] = '\n'.join(sorted(
                        going_by_paper[record['id']].values(), key=str.casefold))
                    row = paper_row(record, member_index, slots_by_paper[record['id']], deadlines, now, link_access, openreview)
                    if row['_link_problems']:
                        link_problems[record['id']] = row['_link_problems']
                    status_counts[status_kind(row['PI review'])] += 1
                    rows.append(row)
                else:
                    rows.append([cell(record.get(field)) for field in fields])
            if tab == 'PaperList':
                rows.sort(key=lambda row: row.pop('_sort'))
                for row in rows:
                    row.pop('_link_problems')
                # Cells show labels; (label, url) pairs travel separately and become per-label hyperlinks.
                paper_links = [[[] for _ in fields], *[
                    [[list(pair) for pair in row[f]] if f in LINK_COLUMNS else [] for f in fields] for row in rows]]
                rows = [[LINK_SEPARATOR.join(label for label, _ in row[f]) if f in LINK_COLUMNS else cell(row[f])
                         for f in fields] for row in rows]
            data.append({'range': f"'{tab}'!A1", 'values': [
                list(fields), *rows,
            ]})
        if people_values is not None:
            data[0]['values'] = order_people_values(people_values)
        if full_people:
            data[0]['values'] = full_people_values(connection, records['PeopleList'], records['PaperList'], timestamp)
    finally:
        connection.rollback()
    # RAW is mandatory: a name/title beginning with '=' must remain text, not a formula.
    return {'valueInputOption': 'RAW', 'data': data, 'paperLinks': paper_links,
            'statusCounts': {value: status_counts[value] for value in PI_REVIEW_VALUES if status_counts[value]},
            'linkProblems': link_problems}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--people-sheet-id', type=int)
    parser.add_argument('--papers-sheet-id', type=int)
    parser.add_argument('--people-export', help='Private on-host JSON values from the existing Members export')
    parser.add_argument('--full-people', action='store_true', help='Export all approved member columns directly from the database')
    parser.add_argument('--output', required=True, help='Private on-host JSON output; never stdout')
    args = parser.parse_args()
    uri = Path(args.database).resolve().as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True, timeout=15) as connection:
        connection.execute('PRAGMA query_only=ON')
        people_values = None
        if args.people_export:
            people_values = json.loads(Path(args.people_export).read_text())['values']
        if args.people_export and args.full_people:
            parser.error('--people-export and --full-people are mutually exclusive')
        payload = snapshot(connection, datetime.datetime.now(datetime.timezone.utc).isoformat(), people_values, args.full_people)
        for key in ('paperLinks', 'statusCounts', 'linkProblems'):
            payload.pop(key)
    # Keep freeze requests separate from the values API payload.
    if args.people_sheet_id is not None or args.papers_sheet_id is not None:
        payload = {'valuesBatch': payload, 'layoutRequests': [
            {'updateSheetProperties': {
                'properties': {'sheetId': sheet_id, 'gridProperties': {
                    'frozenRowCount': 1, 'frozenColumnCount': 1}},
                'fields': 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
            }} for sheet_id in (args.people_sheet_id, args.papers_sheet_id)
            if sheet_id is not None
        ]}
    # Exclusive creation prevents overwriting another export or following an existing symlink.
    import os
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(payload, output)
    print('Prepared PeopleList and PaperList snapshot; no database or Google Drive writes performed.')


if __name__ == '__main__':
    main()
