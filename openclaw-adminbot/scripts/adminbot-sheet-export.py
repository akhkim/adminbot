#!/usr/bin/env python3
"""Prepare a one-way, allowlisted Sheets values batch. Run on the database host."""
import argparse
import datetime
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl

PEOPLE = ('id', 'name', 'member_type', 'status', 'affiliation', 'research_topics')
PAPER_LINKS = {
    'overleaf_link': ('overleaf_edit_url', 'overleaf_edit'),
    'pdf_link': ('google_drive_pdf_url', 'drive_pdf_arxiv'),
    'submission_link': ('submission_url', 'submission'),
    'arxiv_link': ('arxiv_url', 'arxiv'),
    'project_folder_link': (None, 'project_folder'),
    'brainstorming_link': ('brainstorming_doc_url', None),
    'github_link': ('github_url', None),
    'slides_link': ('google_slides_url', 'slides'),
    'poster_link': ('poster_url', 'poster'),
    'talk_video_link': (None, 'talk_video'),
    'rebuttal_link': (None, 'rebuttal_doc'),
    'twitter_draft_link': ('twitter_draft_url', None),
    'linkedin_draft_link': ('linkedin_draft_url', None),
    'twitter_post_link': (None, 'x_post'),
    'linkedin_post_link': (None, 'linkedin_post'),
}
PAPERS = ('id', 'title', 'pi_review_status', 'review_category', 'accepted_year', 'accepted_venue',
          'acceptance_notification_date', 'review_ready_date', 'started_on', 'going_attendees',
          'missing_recorded_artifacts', 'invalid_recorded_artifacts', 'current_step', 'venue',
          'venue_decision', 'lead_owner', 'deadline', 'blocker', 'next_action', 'last_updated',
          'draft_link', *PAPER_LINKS, 'papermentor_review_status',
          'coauthor_feedback_status', 'affiliation_checked', 'github_link_checked',
          'paper_mentor_checked', 'feedback_givers', 'artifact_statuses', 'authors')

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
audit_events_as_actor update_events_as_actor update_events_as_subject calendar_group'''.split())


PEOPLE_PRIORITY = (
    'id', 'join_date', 'status', 'member_type', 'slack_active', 'membership_review', 'privilege_level',
    'collaborator_subgroup', 'role', 'location', 'current_city', 'timezone',
    'slack_messages_7d', 'receives_nudges', 'hours_per_week', 'affiliation',
    'calendar_group', 'last_login_at', 'compute_access', 'availability',
    'papers_authored_count',
)


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


def paper_review_fields(record, members, slots=()):
    """Recorded review fields only; no ownership, deadline or task inference."""
    artifacts = record.get('artifacts') or {}

    def link(value):
        if not isinstance(value, str):
            return ''
        try:
            url = urlsplit(value)
            if url.scheme != 'https' or not url.hostname or url.username or url.password:
                return ''
            if any(key.lower() in {'token', 'key', 'secret', 'password', 'auth', 'signature',
                                  'access_token', 'id_token', 'api_key', 'apikey', 'resourcekey'}
                   or key.lower().startswith(('x-amz-', 'x-goog-'))
                   for key, _ in parse_qsl(url.query)):
                return ''
            # Overleaf read/share URLs carry access tokens; project URLs require existing access.
            if url.hostname.endswith('overleaf.com') and not url.path.startswith('/project/'):
                return ''
        except ValueError:
            return ''
        return value

    by_slot = {row['slot']: row for row in slots}
    links = {}
    for field, (artifact, slot) in PAPER_LINKS.items():
        evidence = by_slot.get(slot, {})
        links[field] = (link(evidence.get('url')) if evidence.get('status') == 'provided' else '')
        if not links[field] and evidence.get('status') != 'invalid':
            links[field] = link(artifacts.get(artifact))
    view = by_slot.get('overleaf_view', {})
    if not links['overleaf_link'] and by_slot.get('overleaf_edit', {}).get('status') != 'invalid':
        links['overleaf_link'] = (link(view.get('url')) if view.get('status') == 'provided' else '')
        if not links['overleaf_link'] and view.get('status') != 'invalid':
            links['overleaf_link'] = link(artifacts.get('overleaf_view_url'))
    owner_id = record.get('lead_owner_member_id')
    owner = members.get(owner_id, {}).get('name', owner_id or '')
    return {
        'review_category': ', '.join(dict.fromkeys([label for slot, label in [('feedback_arr', 'ARR'), ('feedback_arxiv', 'arXiv'), ('feedback_camera_ready', 'Camera-ready')] if by_slot.get(slot, {}).get('status') == 'provided'] + ([record.get('venue') or artifacts.get('conference')] if record.get('venue') or artifacts.get('conference') else []))),
        'venue': record.get('venue') or artifacts.get('conference', ''),
        'lead_owner': record.get('lead_owner') or owner,
        'deadline': record.get('deadline', ''),
        'blocker': '\n'.join(str(artifacts[key]) for key in ['blocker_title', 'blocker_note'] if artifacts.get(key)),
        'next_action': record.get('next_action', ''),
        'last_updated': record.get('updated_at', ''),
        'draft_link': links['overleaf_link'] or links['pdf_link'],
        **links,
    }



def paper_evidence_fields(record, slots):
    by_slot = {row['slot']: row for row in slots}
    def status(name):
        return by_slot.get(name, {}).get('status', 'not recorded')
    settled = lambda name: status(name) in ('provided', 'waived')
    ready = settled('authors_ack') and settled('drive_pdf_arxiv') and not settled('pi_approval')
    checks = record.get('checks') or {}
    return {
        'review_ready_date': by_slot.get('authors_ack', {}).get('provided_at', '') if ready else '',
        'pi_review_status': 'awaiting PI approval' if ready else status('pi_approval'),
        'papermentor_review_status': status('papermentor_review'),
        'coauthor_feedback_status': status('coauthor_feedback'),
        'missing_recorded_artifacts': ', '.join(sorted(row['slot'] for row in slots if row['status'] == 'missing')),
        'invalid_recorded_artifacts': ', '.join(sorted(row['slot'] for row in slots if row['status'] == 'invalid')),
        'artifact_statuses': '\n'.join(sorted(row['slot'] + ': ' + row['status'] for row in slots)) or 'not recorded',
        **{key: checks.get(key, '') for key in ('affiliation_checked', 'github_link_checked', 'paper_mentor_checked')},
    }


def paper_sort_key(record):
    def date_key(value, descending=False):
        try:
            date = datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
            if date.tzinfo is None:
                date = date.replace(tzinfo=datetime.timezone.utc)
            timestamp = date.timestamp()
            return (0, -timestamp if descending else timestamp)
        except ValueError:
            return (1, 0)
    year = record.get('accepted_year')
    return ((0, -int(year)) if str(year).isdigit() else (1, 0),
            date_key(record.get('acceptance_notification_date'), True),
            date_key(record.get('review_ready_date')), date_key(record.get('started_on')),
            record.get('title', ''), record['id'])


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


def snapshot(connection, timestamp, people_values=None, full_people=False):
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
            link_slots = [slot for _, slot in PAPER_LINKS.values() if slot] + ['overleaf_view']
            placeholders = ','.join('?' for _ in link_slots)
            for paper_id, slot, status, provided_at, url in connection.execute(
                    f'SELECT paper_id,slot,status,provided_at,CASE WHEN slot IN ({placeholders}) THEN url ELSE NULL END FROM adminbot_paper_slots', link_slots):
                slots_by_paper[paper_id].append({'slot': slot, 'status': status, 'provided_at': provided_at, 'url': url})
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
                    record.update(paper_review_fields(record, member_index, slots_by_paper[record['id']]))
                    record.update(paper_evidence_fields(record, slots_by_paper[record['id']]))
                rows.append([cell(record.get(field)) for field in fields])
            if tab == 'PaperList':
                rows = [[cell(record.get(field)) for field in fields]
                        for record in sorted(records[tab], key=paper_sort_key)]
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
    return {'valueInputOption': 'RAW', 'data': data}


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
