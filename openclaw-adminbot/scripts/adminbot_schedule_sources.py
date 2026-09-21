"""Official conference schedules: evidence validation, bounded caching, and local extraction.

Fetch and inference are injected for tests. The model transcribes public source text; it
cannot fetch links, execute instructions, or decide that a conflicting date is correct.
"""
import copy
import datetime as dt
import hashlib
import json
import os
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from adminbot_deadline_time import AOE, UTC, timing_fields
from adminbot_workshop_deadlines import _all_dates, MONTHS

VERSION = 3
MAX_TEXT = 80000
MAX_ENTRIES = 60
SOURCE_URLS = {
    'emnlp2026_ws_nlp4pi': ['https://sites.google.com/view/nlp4positiveimpact/call-for-papers-2026'],
    'NeurIPS 2026 workshop contributions': ['https://neurips.cc/Conferences/2026/CallForWorkshops'],
    'ARR May 2026': ['https://aclrollingreview.org/dates'],
    'ARR August 2026': ['https://aclrollingreview.org/dates', 'https://2027.eacl.org/calls/papers/'],
    'ARR October 2026': ['https://aclrollingreview.org/dates'],
    'AACL-IJCNLP 2026:main': ['https://2026.aaclnet.org/calls/main_conference_papers/'],
    'AACL-IJCNLP 2026:demo': ['https://2026.aaclnet.org/calls/demos/'],
    'EMNLP 2026': ['https://2026.emnlp.org/calls/main_conference_papers/'],
    'NeurIPS 2026': ['https://neurips.cc/Conferences/2026/Dates'],
    'ICLR 2027': ['https://iclr.cc/Conferences/2027/CallForPapers', 'https://iclr.cc/Conferences/2027/Dates'],
    'EACL 2027:main': ['https://2027.eacl.org/calls/papers/'],
    'EACL 2027:demo': ['https://2027.eacl.org/calls/demos/'],
    'NAACL 2027': ['https://2027.naacl.org/calls/main_conference_papers/', 'https://aclrollingreview.org/dates'],
}


class SourceUnavailable(ValueError):
    pass


class ExtractionUnavailable(SourceUnavailable):
    pass


class VisibleText(HTMLParser):
    """Keep table boundaries, prose, and footnotes, without executable assets or navigation."""
    def __init__(self):
        super().__init__()
        self.hidden = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style', 'nav', 'footer', 'noscript', 'svg', 'del', 's', 'strike'}:
            self.hidden.append(tag)
        if not self.hidden and tag in {'p', 'tr', 'li', 'h1', 'h2', 'h3', 'br', 'div'}:
            self.parts.append('\n')
        if not self.hidden and tag in {'td', 'th'}:
            self.parts.append(' | ')

    def handle_endtag(self, tag):
        if self.hidden and tag == self.hidden[-1]:
            self.hidden.pop()
        if not self.hidden and tag in {'p', 'tr', 'li', 'h1', 'h2', 'h3', 'div'}:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def normalize(text):
    return ' '.join(text.split())


def source_text(html):
    parser = VisibleText()
    parser.feed(html)
    text = '\n'.join(filter(None, (normalize(line) for line in ''.join(parser.parts).splitlines())))
    if len(text) < 80 or len(text) > MAX_TEXT:
        raise SourceUnavailable('source text empty or exceeds extraction limit')
    return text


def scope_of(item):
    if item.get('id') in SOURCE_URLS:
        return item['id']
    group = item.get('venue_group', '')
    specific = group + ':' + item.get('track', '')
    return specific if specific in SOURCE_URLS else group


def extract_local(context, documents):
    """Ask the authenticated local AdminBot service to run its shared model client."""
    base = os.environ.get('ADMINBOT_SERVICE_BASE_URL', 'http://127.0.0.1:8765').rstrip('/')
    key = os.environ.get('ADMINBOT_SERVICE_TOKEN', '')
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme not in {'http', 'https'} or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}
            or parsed.username or parsed.password or parsed.query or parsed.fragment or not key):
        raise ExtractionUnavailable('local extraction service configuration unavailable')
    request = urllib.request.Request(base + '/internal/deadlines/extract-schedule',
        data=json.dumps({'context': context, 'documents': documents}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(request, timeout=130) as response:
            return json.load(response)
    except Exception as error:
        raise ExtractionUnavailable('local schedule extraction unavailable or invalid') from error


def evidence_dates(text, year):
    """Recognize dates and abbreviated ranges solely to check the model's transcription."""
    dates = {date.isoformat() for _, _, date in _all_dates(text, year)}
    # e.g. September 14-19, 2026; never expand from a date elsewhere on the page.
    month_names = '|'.join(sorted(MONTHS, key=len, reverse=True))
    pattern = rf'\b({month_names})\.?\s+(\d{{1,2}})\s*[-–—]\s*(\d{{1,2}})(?:,?\s+(20\d{{2}}))?'
    for match in re.finditer(pattern, text, re.I):
        actual_year = int(match[4] or year)
        if actual_year != year:
            continue
        for day in (match[2], match[3]):
            try:
                dates.add(dt.date(actual_year, MONTHS[match[1].lower()], int(day)).isoformat())
            except ValueError:
                pass
    return dates


def validate_result(result, documents, context):
    """Reject unsupported facts as a batch; a half-parsed response must not erase stages."""
    if not isinstance(result, dict) or set(result) != {'entries', 'issues'}:
        raise SourceUnavailable('invalid extraction envelope')
    entries, issues = result['entries'], result['issues']
    if not isinstance(entries, list) or not 0 < len(entries) <= MAX_ENTRIES:
        raise SourceUnavailable('no usable schedule')
    if not isinstance(issues, list) or len(issues) > 30 or any(not isinstance(x, str) or len(x) > 1000 for x in issues):
        raise SourceUnavailable('invalid extraction issues')
    allowed_targets = {row['id'] for row in context['targets']} | {'schedule'}
    year = context['year']
    validated = []
    seen = {}
    for row in entries:
        if not isinstance(row, dict) or any(not isinstance(v, str) for v in row.values()):
            raise SourceUnavailable('invalid milestone')
        required = {'target', 'milestone', 'label', 'kind', 'date', 'starts', 'ends',
                    'time', 'timezone', 'source_url', 'evidence', 'time_evidence'}
        if set(row) != required or row['target'] not in allowed_targets or row['kind'] not in {'deadline', 'date', 'period'}:
            raise SourceUnavailable('invalid milestone fields')
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', row['milestone']) or not 0 < len(row['label']) <= 160:
            raise SourceUnavailable('invalid milestone identity')
        document = documents.get(row['source_url'])
        evidence = normalize(row['evidence'])
        if document is None or len(evidence) < 10 or len(evidence) > 6000 or evidence not in normalize(document):
            raise SourceUnavailable('milestone evidence not found')
        values = [row['starts'], row['ends']] if row['kind'] == 'period' else [row['date']]
        if (row['kind'] == 'period' and row['date']) or (row['kind'] != 'period' and (row['starts'] or row['ends'])):
            raise SourceUnavailable('inconsistent milestone dates')
        for value in values:
            if not re.fullmatch(r'20\d{2}-\d{2}-\d{2}', value):
                raise SourceUnavailable('invalid date')
            actual_year = dt.date.fromisoformat(value).year
            if abs(actual_year - year) > 1 or value not in evidence_dates(evidence, actual_year):
                raise SourceUnavailable('date not supported by milestone evidence')
            if actual_year != year and str(actual_year) not in evidence:
                raise SourceUnavailable('cross-year date lacks explicit year')
        if values[0] > values[-1]:
            raise SourceUnavailable('reversed date range')
        zone, clock = row['timezone'], row['time']
        time_evidence = normalize(row['time_evidence'])
        if zone not in {'', 'AoE', 'UTC'} or (clock and not zone):
            raise SourceUnavailable('unsupported or missing timezone')
        if zone or clock:
            if not time_evidence or time_evidence not in normalize(document):
                raise SourceUnavailable('time evidence not found')
            zone_pattern = r'\bAoE\b|anywhere\s+on\s+earth|UTC\s*[-−]\s*12' if zone == 'AoE' else r'\b(?:UTC|GMT)\b(?!\s*[-+−]\s*\d)'
            if not re.search(zone_pattern, time_evidence, re.I):
                raise SourceUnavailable('timezone not supported')
        if clock:
            if not re.fullmatch(r'\d{2}:\d{2}:00', clock):
                raise SourceUnavailable('unsupported time precision')
            hour, minute, _ = map(int, clock.split(':'))
            dt.time(hour, minute)
            formats = [f'{hour:02d}:{minute:02d}', f'{hour}:{minute:02d}',
                       f'{hour % 12 or 12}:{minute:02d} {"pm" if hour >= 12 else "am"}']
            if not any(re.search(r'(?<!\d)' + re.escape(v).replace(r'\ ', r'\s*') + r'(?!\d)', time_evidence, re.I) for v in formats):
                raise SourceUnavailable('time not supported')
            if row['kind'] == 'date':
                raise SourceUnavailable('calendar date cannot acquire a closing time')
        stamp = values[-1]
        if clock:
            moment = dt.datetime.fromisoformat(stamp + 'T' + clock).replace(tzinfo=AOE if zone == 'AoE' else UTC)
            timing = timing_fields(moment.astimezone(AOE).strftime('%Y-%m-%d %H:%M:%S'), timezone=zone)
        else:
            timing = timing_fields(stamp, date_only=True, timezone=zone)
        candidate = dict(row, **timing)
        identity = row['target'] if row['target'] != 'schedule' else (row['milestone'], row['label'])
        signature = (row['kind'], *values, clock, zone)
        if identity in seen:
            if seen[identity] != signature:
                raise SourceUnavailable('conflicting official milestone dates')
            continue
        seen[identity] = signature
        validated.append(candidate)
    return validated, list(issues)


def refresh_schedules(items, previous_by_id, clock, force_refresh=False, *, fetch_html, extract=extract_local):
    """Refresh once per scope/day, infer only on text/config changes, retain failed observations."""
    groups = {}
    for item in items:
        scope = scope_of(item)
        if scope in SOURCE_URLS:
            groups.setdefault(scope, []).append(item)
    pages = {}
    now = clock.now.isoformat().replace('+00:00', 'Z')
    for scope, rows in groups.items():
        previous = next((previous_by_id[row['id']] for row in rows
                         if previous_by_id.get(row['id'], {}).get('schedule_observation')
                         or previous_by_id.get(row['id'], {}).get('schedule_attempted_at')), {})
        observation = copy.deepcopy(previous.get('schedule_observation', {}))
        for row in rows:
            old = previous_by_id.get(row['id'], {})
            for key, value in old.items():
                if key.startswith('schedule_'):
                    row[key] = copy.deepcopy(value)
            row['schedule'] = copy.deepcopy(old.get('schedule', []))
            row['schedule_status'] = old.get('schedule_status', 'unverified')
        retry_at = previous.get('schedule_retry_at', '')
        if not force_refresh and retry_at and now < retry_at:
            continue
        checked = observation.get('checked_at', '')
        try:
            age = (clock.now - dt.datetime.fromisoformat(checked.replace('Z', '+00:00'))).total_seconds()
        except (ValueError, TypeError):
            age = -1
        if not force_refresh and 0 <= age < 86400:
            for row in rows:
                if not row.get('_primary_attempted'):
                    row['_source_observed'] = not previous_by_id.get(row['id'], {}).get('stale', True)
            continue
        context = {'scope': scope, 'year': int(re.search(r'20\d{2}', scope)[0]),
                   'targets': [{'id': row['id'], 'label': row['deadline_label']} for row in rows]}
        if rows[0].get('_schedule_purpose'):
            context['purpose'] = rows[0]['_schedule_purpose']
        try:
            documents = {}
            for url in SOURCE_URLS[scope]:
                if url not in pages:
                    try:
                        final, html = fetch_html(url)
                        if urllib.parse.urlsplit(final).hostname != urllib.parse.urlsplit(url).hostname:
                            raise SourceUnavailable('official source redirected to another host')
                        pages[url] = source_text(html)
                    except Exception:
                        pages[url] = None
                if pages[url] is None:
                    raise SourceUnavailable('official page unavailable')
                documents[url] = pages[url]
            if sum(map(len, documents.values())) > MAX_TEXT:
                raise SourceUnavailable('combined official text exceeds extraction limit')
            payload = {'version': VERSION, 'model': os.environ.get('ADMINBOT_LOCAL_MODEL', ''),
                       'context': context, 'documents': documents}
            digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            if digest == observation.get('hash') and observation.get('entries'):
                entries, issues = validate_result(observation['raw'], documents, context)
            else:
                try:
                    raw = extract(context, documents)
                    entries, issues = validate_result(raw, documents, context)
                except Exception as error:
                    raise ExtractionUnavailable('extracted schedule failed evidence validation') from error
                observation = {'hash': digest, 'raw': raw, 'entries': entries, 'issues': issues,
                               'extracted_at': now, 'version': VERSION}
            removed_stages = observation.setdefault('removed_stages', {})
            for row in rows:
                old_labels = {stage.get('label') for stage in previous_by_id.get(row['id'], {}).get('schedule', [])}
                missing = old_labels - {entry['label'] for entry in entries if entry['target'] == 'schedule'}
                if missing:
                    removed_stages[row['id']] = sorted(missing)
            observation['checked_at'] = now
            observation['sources'] = list(documents)
            for row in rows:
                row.pop('schedule_retry_at', None)
                row.pop('schedule_failure_count', None)
                row['schedule_attempted_at'] = now
                row['schedule_observation'] = copy.deepcopy(observation)
                row['schedule_checked_at'] = now
                row['schedule_extracted_at'] = observation['extracted_at']
                row['schedule_status'] = 'needs_review' if issues else 'source_backed'
                row['schedule_issues'] = issues[:]
                row['schedule'] = [project_milestone(entry) for entry in entries if entry['target'] == 'schedule']
                missing = removed_stages.get(row['id'], [])
                if missing:
                    row['schedule_status'] = 'needs_review'
                    row['schedule_issues'].append('Previously listed stages changed or absent: ' + ', '.join(sorted(missing)))
                primary = next((entry for entry in entries if entry['target'] == row['id']), None)
                if primary is None:
                    row['schedule_status'] = 'needs_review'
                    row['schedule_issues'].append('Primary deadline not found in official schedule')
                elif row.get('_source_observed') and row.get('deadline_aoe', '')[:16] != primary['deadline_aoe'][:16]:
                    row['schedule_status'] = 'needs_review'
                    row['schedule_issues'].append('Official schedule disagrees with separately observed primary deadline')
                else:
                    row.update({key: value for key, value in primary.items() if key.startswith('deadline_')})
                    row.update(source_url=primary['source_url'], deadline_source_kind='official_schedule',
                               deadline_source_evidence=primary['evidence'], source_checked_at=now,
                               deadline_source_status='source_backed', _source_observed=True)
        except Exception as error:
            for row in rows:
                # Never advance the successful-check clock after a failed page/model/validation call.
                row['schedule_observation'] = copy.deepcopy(previous.get('schedule_observation', {}))
                row['schedule_status'] = 'extraction_unavailable' if isinstance(error, ExtractionUnavailable) else 'source_unavailable'
                row['schedule_issues'] = [str(error) if isinstance(error, SourceUnavailable) else 'Official schedule extraction failed']
                row['schedule_attempted_at'] = now
                failures = min(int(previous.get('schedule_failure_count', 0)) + 1, 8)
                row['schedule_failure_count'] = failures
                row['schedule_retry_at'] = (clock.now + dt.timedelta(seconds=min(900 * 2 ** (failures - 1), 86400))).isoformat().replace('+00:00', 'Z')
    return items


def project_milestone(entry):
    row = {key: entry[key] for key in ('milestone', 'label', 'kind', 'source_url', 'evidence')}
    if entry['kind'] == 'period':
        row.update(starts=entry['starts'], ends=entry['ends'])
    else:
        row['date'] = entry['deadline_aoe'] if entry['time'] else entry['date']
        if not entry['time']:
            row['kind'] = 'date'
    if entry['kind'] == 'deadline' or (entry['kind'] == 'period' and entry['milestone'] != 'conference'):
        row['planning_at'] = entry['deadline_planning_at']
    return row
