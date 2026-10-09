#!/usr/bin/env python3
"""Synthetic regression check: python3 scripts/adminbot-sheet-export-test.py"""
import importlib.util
import json
import sqlite3
from pathlib import Path

spec = importlib.util.spec_from_file_location('exporter', Path(__file__).with_name('adminbot-sheet-export.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
c = sqlite3.connect(':memory:')
for table in ['adminbot_lab_members', 'adminbot_papers']:
    c.execute(f'CREATE TABLE {table}(id TEXT, payload_json TEXT)')
c.execute('INSERT INTO adminbot_lab_members VALUES (?,?)', ('person', json.dumps({'id':'person', 'name':'=IMPORTXML("private")', 'email':'private@example.org', 'notes':'private notes', 'onboarding':{'secret':'private'}})))
c.execute('INSERT INTO adminbot_papers VALUES (?,?)', ('paper', json.dumps({'id':'paper', 'title':'Example', 'authors':['Ada','Grace'], 'artifacts':{'conference':'AACL 2026','overleaf_url':'private-link'}})))
c.commit()
before = c.total_changes
payload = exporter.snapshot(c, '2026-10-01T00:00:00Z')
assert payload['valueInputOption'] == 'RAW'
assert [x['range'] for x in payload['data']] == ["'PeopleList'!A1", "'PaperList'!A1"]
assert payload['data'][0]['values'][1][exporter.ordered_people_columns(exporter.PEOPLE).index('name')] == '=IMPORTXML("private")'
assert payload['data'][0]['values'][1][exporter.ordered_people_columns(exporter.PEOPLE).index('status')] == ''
paper = dict(zip(payload['data'][1]['values'][0], payload['data'][1]['values'][1]))
assert paper['authors'] == 'Ada, Grace'
assert paper['venue'] == 'AACL 2026'
assert paper['lead_owner'] == paper['deadline'] == paper['next_action'] == ''
review = exporter.paper_review_fields({'lead_owner_member_id': 'person', 'deadline': '2026-11-01',
    'next_action': 'Review draft', 'updated_at': '2026-10-01T00:00:00Z', 'artifacts': {
        'overleaf_edit_url': 'https://www.overleaf.com/project/123',
        'overleaf_share_url': 'NEVER_EXPORT_SHARE_TOKEN', 'arxiv_paper_password': 'NEVER_EXPORT_PAPER_PASSWORD',
        'submission_url': 'https://example.test/paper?id=12', 'arxiv_url': 'https://arxiv.org/abs/1234.5678',
        'blocker_title': 'Awaiting data', 'blocker_note': 'Need updated dataset'}},
    {'person': {'name': 'Ada'}})
assert review['lead_owner'] == 'Ada' and review['deadline'] == '2026-11-01'
assert review['next_action'] == 'Review draft' and review['last_updated'] == '2026-10-01T00:00:00Z'
assert review['blocker'] == 'Awaiting data\nNeed updated dataset'
assert review['draft_link'] == 'https://www.overleaf.com/project/123'
assert 'NEVER_EXPORT' not in json.dumps(review)
for unsafe in ['https://www.overleaf.com/read/secret', 'https://example.test/?token=secret',
               'javascript:alert(1)', 'https://user:password@example.test/paper']:
    assert exporter.paper_review_fields({'artifacts': {'overleaf_edit_url': unsafe}}, {})['draft_link'] == ''
assert 'private@example.org' not in json.dumps(payload)
assert 'private notes' not in json.dumps(payload)
assert 'private-link' not in json.dumps(payload)
assert c.total_changes == before
print('PASS: allowlist, missing status, venue fallback, RAW formula safety, read-only snapshot')

headers = ['name', 'id', 'notes', 'member_type', 'join_date', 'status', 'other']
expected = ['id', 'join_date', 'status', 'member_type', 'name', 'notes', 'other']
assert exporter.ordered_people_columns(headers) == expected
requests = exporter.people_layout_requests(headers, 123)
for request in requests[:-1]:
    move = request['moveDimension']
    headers.insert(move['destinationIndex'], headers.pop(move['source']['startIndex']))
assert headers == expected
assert len(exporter.people_layout_requests(expected, 123)) == 1
assert requests[-1]['updateSheetProperties']['properties']['gridProperties'] == {'frozenRowCount': 1, 'frozenColumnCount': 1}
print('PASS: requested column order, remaining-column preservation, repeat-safe moves, 1x1 freeze')

full = [['name', 'id', 'status', 'calendar_group', 'extra'], ['=SUM(1)', 'p1', 'active', 'lab'], ['Person 2', 'p2']]
ordered = exporter.order_people_values(full)
assert ordered[0] == ['id', 'status', 'calendar_group', 'name', 'extra']
assert ordered[1] == ['p1', 'active', 'lab', '=SUM(1)', '']
assert ordered[2] == ['p2', '', '', 'Person 2', '']
assert exporter.order_people_values(ordered) == ordered
assert exporter.snapshot(c, '', full)['data'][0]['values'] == ordered
for invalid in [[], [['name']], [['id', 'id']], [['id'], ['p', 'extra']]]:
    try:
        exporter.order_people_values(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError('Invalid export accepted')
print('PASS: full export preservation, sparse rows, header validation, exact tab names')

# Direct database export must include new members and aggregate only explicit IDs.
c.execute('INSERT INTO adminbot_lab_members VALUES (?,?)', ('new', json.dumps({
    'id': 'new', 'name': 'New person', 'joined_month': '2026-09',
    'avatar_url': 'data:image/png;base64,' + 'x' * 50000,
    'onboarding': {'steps': [{'id': 'a'}, {'id': 'b'}], 'completed': [{'id': 'a'}],
                   'remaining': [{'id': 'b'}], 'current_step': {'id': 'b'}}})))
c.execute('UPDATE adminbot_papers SET payload_json=?', (json.dumps({
    'id': 'paper', 'title': '=IMPORTXML("private")',
    'author_links': [{'member_id': 'new'}, {'member_id': 'new'}],
    'submitted_by_member_id': 'new'}),))
c.execute('CREATE TABLE adminbot_member_credentials(member_id, email, claimed_at, updated_at, password_scrypt)')
c.execute('INSERT INTO adminbot_member_credentials VALUES (?,?,?,?,?)', ('new', 'new@example.test', '2026-09-01', '2026-09-02', 'NEVER_EXPORT_PASSWORD'))
c.execute('CREATE TABLE adminbot_sessions(member_id, expires_at, revoked_at, token_hash)')
c.executemany('INSERT INTO adminbot_sessions VALUES (?,?,?,?)', [
    ('new', '2026-10-02T00:00:00Z', None, 'NEVER_EXPORT_TOKEN'),
    ('new', '2026-09-01T00:00:00Z', None, 'EXPIRED_TOKEN'),
    ('new', '2026-10-02T00:00:00Z', '2026-09-30', 'REVOKED_TOKEN')])
c.execute('CREATE TABLE adminbot_member_notifications(member_id, created_at, read_at, kind)')
c.executemany('INSERT INTO adminbot_member_notifications VALUES (?,?,?,?)', [
    ('new', '2026-09-29', None, 'paper'), ('new', '2026-09-30', '2026-09-30', 'meeting')])
c.commit()
before = c.total_changes
direct = exporter.snapshot(c, '2026-10-01T00:00:00Z', full_people=True)
columns = direct['data'][0]['values'][0]
rows = [dict(zip(columns, row)) for row in direct['data'][0]['values'][1:]]
new = next(row for row in rows if row['id'] == 'new')
assert len(columns) == len(set(columns)) == 133
assert columns[:len(exporter.PEOPLE_PRIORITY)] == list(exporter.PEOPLE_PRIORITY)
assert len(rows) == 2
assert new['join_date'] == '2026-09' and new['join_date_basis'] == 'joined_month'
assert new['onboarding_completed_count'] == '1' and new['onboarding_current_step'] == 'b'
assert new['papers_authored_count'] == '1' and new['papers_submitted_count'] == '1'
assert new['active_sessions'] == '1'
assert new['avatar_url'] == '[Embedded profile image omitted: exceeds Google Sheets cell limit]'
assert new['notifications_total'] == '2' and new['notifications_unread'] == '1'
assert new['slack_messages_7d'] == '' and new['password_resets'] == ''
assert 'NEVER_EXPORT' not in json.dumps(direct)
assert c.total_changes == before
assert direct['data'][1]['values'][1][1] == '=IMPORTXML("private")'
print('PASS: direct database roster, 133 columns, explicit-ID aggregates, missing-value semantics, auth-secret exclusion')

refresh_spec = importlib.util.spec_from_file_location('refresh', Path(__file__).with_name('adminbot-sheet-refresh.py'))
refresh = importlib.util.module_from_spec(refresh_spec)
refresh_spec.loader.exec_module(refresh)
properties = {title: {'sheetId': sid, 'gridProperties': {'rowCount': 1000, 'columnCount': 131}}
              for title, sid in [('PeopleList', 1), ('PaperList', 2)]}
requests = refresh.refresh_requests(direct, properties)
clears = [r['repeatCell'] for r in requests if r.get('repeatCell', {}).get('fields') == 'userEnteredValue']
assert len(clears) == 2
assert {r['range']['sheetId'] for r in clears} == {1, 2}
assert len([r for r in requests if 'addTable' in r]) == 2
assert all(r['range']['startRowIndex'] == 1 for r in clears)
assert len([r for r in requests if 'addFilterView' in r]) == 11
stage_view = next(r['addFilterView']['filter'] for r in requests
                  if r.get('addFilterView', {}).get('filter', {}).get('title') == 'By stage')
assert stage_view['sortSpecs'][0]['dimensionIndex'] == exporter.PAPERS.index('current_step')
assert exporter.PAPERS[:9] == ('id', 'title', 'pi_review_status', 'review_category', 'accepted_year',
    'accepted_venue', 'acceptance_notification_date', 'overleaf_edit_link', 'started_on')
assert stage_view['range']['endColumnIndex'] == len(exporter.PAPERS)
properties['PeopleList']['filterViews'] = [{'title': 'PeopleList sort and filter', 'filterViewId': 42}]
resized = refresh.refresh_requests(direct, properties)
updated_view = next(r['updateFilterView'] for r in resized if 'updateFilterView' in r)
assert updated_view['fields'] == 'range' and updated_view['filter']['filterViewId'] == 42
assert updated_view['filter']['range']['endRowIndex'] == len(direct['data'][0]['values'])
properties['PaperList']['bandedRanges'] = [{'bandedRangeId': 123}]
restyled = refresh.refresh_requests(direct, properties)
assert not any('addBanding' in r for r in restyled)
assert next(r['deleteBanding']['bandedRangeId'] for r in restyled if 'deleteBanding' in r) == 123
properties['PaperList']['tables'] = [{'name': 'PaperList', 'tableId': 'paper-table'}]
converted = refresh.refresh_requests(direct, properties)
updated_table = next(r['updateTable']['table'] for r in converted if 'updateTable' in r)
assert updated_table['tableId'] == 'paper-table'
assert updated_table['range']['endRowIndex'] == len(direct['data'][1]['values'])
assert updated_table['columnProperties'][exporter.PAPERS.index('current_step')]['columnType'] == 'TEXT'  # No stage supplied in this synthetic row.
assert not any('deleteBanding' in r for r in converted)
paper_views = [r['addFilterView']['filter'] for r in converted if r.get('addFilterView', {}).get('filter', {}).get('tableId') == 'paper-table']
assert len(paper_views) == 6
assert all(v['tableId'] == 'paper-table' and 'range' not in v for v in paper_views)
properties['PaperList']['filterViews'] = [{'title': 'By stage', 'filterViewId': 43, 'tableId': 'paper-table'}]
migrated = refresh.refresh_requests(direct, properties)
stage_update = next(r['updateFilterView'] for r in migrated
                    if r.get('updateFilterView', {}).get('filter', {}).get('filterViewId') == 43)
assert stage_update['fields'] == 'range,namedRangeId,tableId,sortSpecs'
assert stage_update['filter']['tableId'] == 'paper-table' and 'range' not in stage_update['filter']
properties['PaperList']['filterViews'][0].pop('tableId')
recreated = refresh.refresh_requests(direct, properties)
assert {'deleteFilterView': {'filterId': 43}} in recreated
assert any(r.get('addFilterView', {}).get('filter', {}).get('title') == 'By stage' for r in recreated)
assert all(r.get('repeatCell', {}).get('range', {}).get('sheetId') == 2 for r in restyled
           if r.get('repeatCell', {}).get('fields', '').startswith('userEnteredFormat'))
paper_write = next(r['updateCells'] for r in requests if 'updateCells' in r and r['updateCells']['range']['sheetId'] == 2)
assert paper_write['rows'][1]['values'][1] == {'userEnteredValue': {'stringValue': '=IMPORTXML("private")'}}
invalid = json.loads(json.dumps(direct))
invalid['data'][0]['values'].append(invalid['data'][0]['values'][1])
try:
    refresh.refresh_requests(invalid, properties)
except ValueError:
    pass
else:
    raise AssertionError('Duplicate member accepted for publication')
print('PASS: atomic two-tab replacement, stale-row clearing, formula safety and duplicate rejection')

slots = [{'slot': 'authors_ack', 'status': 'provided', 'provided_at': '2026-09-20T12:00:00Z'},
         {'slot': 'drive_pdf_arxiv', 'status': 'waived', 'provided_at': None},
         {'slot': 'slides', 'status': 'invalid', 'provided_at': None},
         {'slot': 'poster', 'status': 'missing', 'provided_at': None}]
evidence = exporter.paper_evidence_fields({}, slots)
assert evidence['pi_review_status'] == 'awaiting PI approval'
assert evidence['review_ready_date'] == '2026-09-20T12:00:00Z'
assert evidence['missing_recorded_artifacts'] == 'poster'
assert evidence['invalid_recorded_artifacts'] == 'slides'
assert exporter.paper_evidence_fields({}, [])['artifact_statuses'] == 'not recorded'
assert exporter.paper_evidence_fields({}, slots + [{'slot': 'pi_approval', 'status': 'provided'}])['review_ready_date'] == ''
sort_rows = [
    {'id': 'unknown'},
    {'id': 'old', 'accepted_year': 2025},
    {'id': 'late', 'accepted_year': 2026, 'acceptance_notification_date': '2026-09-01', 'review_ready_date': '2026-08-01T12:00:00Z'},
    {'id': 'early', 'accepted_year': 2026, 'acceptance_notification_date': '2026-09-01', 'review_ready_date': '2026-08-01T09:00:00Z'},
    {'id': 'newest', 'accepted_year': 2026, 'acceptance_notification_date': '2026-09-20'},
]
assert [r['id'] for r in sorted(sort_rows, key=exporter.paper_sort_key)] == ['newest', 'early', 'late', 'old', 'unknown']
assert exporter.paper_sort_key({'id': 'a', 'started_on': '2020-01-01'}) < exporter.paper_sort_key({'id': 'b', 'started_on': '2021-01-01'})
print('PASS: PI readiness, recorded missing/invalid artifacts, requested sort order and unknown dates last')

visibility_values = [list(exporter.PAPERS), [''] * len(exporter.PAPERS)]
visibility_values[1][0] = 'paper'
visibility_values[1][1] = '0'
visibility_values[1][2] = 'False'
def column_visibility(values):
    return {r['updateDimensionProperties']['range']['startIndex']:
            r['updateDimensionProperties']['properties']['hiddenByUser']
            for r in refresh.paper_style_requests(properties['PaperList'], values)
            if 'hiddenByUser' in r.get('updateDimensionProperties', {}).get('properties', {})}
hidden = column_visibility(visibility_values)
assert hidden[3] and not any(hidden[i] for i in (0, 1, 2))
visibility_values[1][3] = 'New material'
assert not column_visibility(visibility_values)[3]
print('PASS: empty columns hidden, populated columns restored, zero/false values retained')

c.execute('CREATE TABLE adminbot_paper_slots(paper_id TEXT, slot TEXT, status TEXT, provided_at TEXT, url TEXT)')
c.executemany('INSERT INTO adminbot_paper_slots VALUES (?,?,?,?,?)', [
    ('paper', 'drive_pdf_arxiv', 'provided', '2026-10-01', 'https://drive.google.com/file/d/pdf/view'),
    ('paper', 'project_folder', 'provided', '2026-10-01', 'https://drive.google.com/drive/folders/folder'),
    ('paper', 'overleaf_share', 'provided', '2026-10-01', 'NEVER_EXPORT_SHARE_TOKEN'),
])
c.commit()
linked = exporter.snapshot(c, '2026-10-01T00:00:00Z')['data'][1]['values']
linked_row = dict(zip(linked[0], linked[1]))
assert linked_row['pdf_link'] == linked_row['draft_link'] == 'https://drive.google.com/file/d/pdf/view'
assert linked_row['project_folder_link'] == 'https://drive.google.com/drive/folders/folder'
assert 'NEVER_EXPORT_SHARE_TOKEN' not in json.dumps(linked)
invalid_links = exporter.paper_review_fields({'artifacts': {'google_drive_pdf_url': 'https://example.test/old'}}, {},
    [{'slot': 'drive_pdf_arxiv', 'status': 'invalid', 'url': 'https://example.test/bad'}])
assert invalid_links['pdf_link'] == invalid_links['draft_link'] == ''
formatted_links = next(r['updateCells'] for r in refresh.paper_style_requests(properties['PaperList'], linked)
                       if r.get('updateCells', {}).get('fields') == 'userEnteredFormat.textFormat.link')
pdf_offset = exporter.PAPERS.index('pdf_link') - exporter.PAPERS.index('draft_link')
assert formatted_links['rows'][0]['values'][pdf_offset]['userEnteredFormat']['textFormat']['link']['uri'] == linked_row['pdf_link']
print('PASS: slot-backed clickable paper links, invalid artifact rejection and sharing-token exclusion')

c.execute('CREATE TABLE adminbot_paper_conference_attendees(paper_id TEXT, attendee_key TEXT, member_id TEXT, name TEXT, attending TEXT)')
c.executemany('INSERT INTO adminbot_paper_conference_attendees VALUES (?,?,?,?,?)', [
    ('paper', 'member:grace', 'grace', 'Grace', 'yes'),
    ('paper', 'member:ada', 'ada', 'Ada', 'yes'),
    ('paper', 'member:ada', 'ada', 'Ada', 'yes'),
    ('paper', 'member:bob', 'bob', 'Bob', 'no'),
    ('paper', 'member:jo', 'jo', 'Jo', 'unknown'),
    ('other-paper', 'member:elsewhere', 'elsewhere', 'Elsewhere', 'yes'),
])
c.commit()
attendance = exporter.snapshot(c, '2026-10-03T08:41:44Z')['data'][1]['values']
assert dict(zip(attendance[0], attendance[1]))['going_attendees'] == 'Ada\nGrace'
assert dict(zip(attendance[0], attendance[1]))['authors'] == linked_row['authors']
assert attendance[0][attendance[0].index('started_on') + 1] == 'going_attendees'
print('PASS: Going-only alphabetical PaperList column, identity deduplication, paper isolation, original authors retained')

assert exporter.people_review_fields({'slack_user_id': 'U1', 'slack_channels': ['#jinesis-active'], 'status': 'inactive'}) == {'slack_active': 'Recorded yes', 'membership_review': 'Review inactive'}
assert exporter.people_review_fields({'slack_user_id': 'U1', 'slack_channels': []})['slack_active'] == 'Recorded no'
assert exporter.people_review_fields({'slack_channels': ['jinesis-active']})['slack_active'] == 'Unknown'
assert exporter.people_review_fields({'slack_user_id': 'U1'})['slack_active'] == 'Unknown'
assert sorted([{'id': 'unknown'}, {'id': 'old', 'joined_month': '2025-01'}, {'id': 'new', 'joined_month': '2026-10'}], key=exporter.people_sort_key)[0]['id'] == 'old'
assert exporter.paper_review_fields({'artifacts': {'conference': 'NeurIPS 2026'}}, {})['review_category'] == 'NeurIPS'
print('PASS: recorded channel membership, unknown evidence, inactive status and joined-month ordering')

assert exporter.paper_review_fields({}, {}, [{'slot': 'feedback_arr', 'status': 'provided'}, {'slot': 'feedback_arxiv', 'status': 'provided'}])['review_category'] == 'ARR, arXiv'
views = [r['addFilterView']['filter'] for r in refresh.refresh_requests(direct, properties) if 'addFilterView' in r]
inactive = next(v for v in views if v['title'] == 'Review inactive members')
assert inactive['criteria'][str(columns.index('membership_review'))]['condition']['values'] == [{'userEnteredValue': 'Review inactive'}]
assert next(v for v in views if v['title'] == 'By joined date')['sortSpecs'][0]['sortOrder'] == 'ASCENDING'
print('PASS: inactive-only filter view, ascending joined view, explicit feedback categories')

assert exporter.people_review_fields({'status': 'active', 'member_type': 'coauthor-major, alumni'})['membership_review'] == 'Review inactive'

assert exporter.normalized_join_date('Jan-26') == '2026-01'
assert exporter.normalized_join_date('June 2025') == '2025-06'
assert exporter.normalized_join_date('2025') == '2025'
assert exporter.normalized_join_date('1/1/2026') == '2026-01-01'
for invalid in ('1000-01', '206-09', '26-Jun', '2/3/2026', '2026-02-30'):
    assert exporter.normalized_join_date(invalid) == '', invalid
assert [r['id'] for r in sorted([{'id': 'unknown'}, {'id': 'later', 'joined_month': 'Jan-26'}, {'id': 'earlier', 'joined_month': 'June 2025'}], key=exporter.people_sort_key)] == ['earlier', 'later', 'unknown']
print('PASS: canonical join dates, precision, ambiguous values and oldest-first ordering')

assert [r['id'] for r in sorted([{'id': 'day', 'join_date': '2026-01-01'}, {'id': 'month', 'join_date': '2026-01'}, {'id': 'year', 'join_date': '2026'}], key=exporter.people_sort_key)] == ['year', 'month', 'day']

assert exporter.paper_evidence_fields({}, [{'slot': 'pi_approval', 'status': 'provided'}])['pi_review_status'] == 'Approved'
assert exporter.paper_evidence_fields({}, [{'slot': 'pi_approval', 'status': 'waived'}])['pi_review_status'] == 'Approval waived'
assert exporter.paper_evidence_fields({}, [{'slot': 'pi_approval', 'status': 'missing'}])['pi_review_status'] == 'Not ready for PI approval'
assert exporter.paper_evidence_fields({}, [])['pi_review_status'] == 'Not recorded'
pending = [{'id': 'new-pending', 'pi_review_status': 'awaiting PI approval', 'review_ready_date': '2026-10-09'},
           {'id': 'approved', 'pi_review_status': 'Approved', 'accepted_year': 2027},
           {'id': 'old-pending', 'pi_review_status': 'awaiting PI approval', 'review_ready_date': '2026-10-01'}]
assert [r['id'] for r in sorted(pending, key=exporter.paper_sort_key)] == ['old-pending', 'new-pending', 'approved']
view = next(r['addFilterView']['filter'] for r in refresh.refresh_requests(direct, properties)
            if r.get('addFilterView', {}).get('filter', {}).get('title') == 'Awaiting PI approval')
assert view['criteria'][str(exporter.PAPERS.index('pi_review_status'))]['condition']['values'] == [{'userEnteredValue': 'awaiting PI approval'}]
assert view['sortSpecs'][0] == {'dimensionIndex': exporter.PAPERS.index('review_ready_date'), 'sortOrder': 'ASCENDING'}
print('PASS: authoritative PI labels, pending-first oldest-wait ordering and native approval filter')

assert exporter.paper_review_fields({"venue": " ARR Acceptance, Committed to EMNLP 2026, neurips 2026, NeurIPS "}, {})["review_category"] == "ARR, EMNLP, NeurIPS"
assert exporter.paper_review_fields({"venue": "arXiv"}, {}, [{"slot": "feedback_arxiv", "status": "provided"}])["review_category"] == "arXiv"
assert exporter.paper_review_fields({}, {})["review_category"] == "Not recorded"
assert exporter.paper_review_fields({"venue": "REALM workshop @EMNLP"}, {})["review_category"] == "REALM workshop @EMNLP"
print("PASS: canonical review categories, year removal, aliases, deduplication and unfamiliar venue preservation")

assert exporter.paper_review_fields({"venue": "EMNLP 2026 (main)"}, {})["review_category"] == "EMNLP"

assert review["overleaf_edit_link"] == "https://www.overleaf.com/project/123"
assert exporter.paper_review_fields({}, {}, [{"slot": "overleaf_view", "status": "provided", "url": "https://www.overleaf.com/project/456"}])["overleaf_edit_link"] == ""
assert exporter.PAPERS.index("review_ready_date") > exporter.PAPERS.index("overleaf_edit_link")
print("PASS: early edit-only Overleaf column, no view fallback mislabeled edit, waiting-date sorting preserved")
