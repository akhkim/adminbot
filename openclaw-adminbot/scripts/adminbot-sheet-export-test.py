#!/usr/bin/env python3
"""Synthetic regression check: python3 scripts/adminbot-sheet-export-test.py"""
import datetime
import importlib.util
import json
import sqlite3
from pathlib import Path
from zoneinfo import ZoneInfo

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
assert paper['Authors'] == 'Ada, Grace'
assert paper['Venue'] == 'ARR · cycle not recorded' and paper['Venue (as entered)'] == 'AACL 2026'
assert paper['Lead'] == paper['PI review'] == paper['Review link'] == ''
NOW = exporter.parse_time('2026-10-11T12:00:00Z')
row = exporter.paper_row({'id': 'p', 'title': 'T', 'lead_owner_member_id': 'person', 'next_action': 'Review draft',
    'updated_at': '2026-10-01T00:00:00Z', 'artifacts': {
        'overleaf_edit_url': 'https://www.overleaf.com/project/123', 'arxiv_paper_password': 'NEVER_EXPORT_PAPER_PASSWORD',
        'submission_url': 'https://example.test/paper?id=12', 'arxiv_url': 'https://arxiv.org/abs/1234.5678',
        'blocker_title': 'Awaiting data', 'blocker_note': 'Need updated dataset'}},
    {'person': {'name': 'Ada'}}, [], [], NOW)
assert row['Lead'] == 'Ada' and row['Last updated'] == 'Wed Sep 30, 2026'  # 8 PM Toronto the previous day
assert row['Blocker / next step'] == 'Awaiting data\nNeed updated dataset\nReview draft'
assert row['Review link'] == [('Overleaf edit 🔒', 'https://www.overleaf.com/project/123'),
    ('arXiv', 'https://arxiv.org/abs/1234.5678'), ('Submission', 'https://example.test/paper?id=12')]
assert row['Link problems'] == 'Overleaf edit: project link opens only for people invited to the project'
assert 'NEVER_EXPORT' not in json.dumps(row, default=str)
# Overleaf share and read-only links are exported by operator decision; unsafe URLs are still dropped.
for allowed in ['https://www.overleaf.com/read/abc#f7', 'https://www.overleaf.com/3587461615abcdef#d4']:
    assert exporter.safe_link(allowed) == allowed
for unsafe in ['https://example.test/?token=secret', 'javascript:alert(1)', 'http://example.test/x',
               'https://user:password@example.test/paper', 'https://example.test/?X-Amz-Signature=1']:
    assert exporter.safe_link(unsafe) == ''
assert exporter.safe_link('https://www.google.com/url?q=https://arxiv.org/abs/1') == 'https://arxiv.org/abs/1'
ARR_DEADLINES = [{'name': 'ACL 2027 (ARR January submission)', 'conference': 'ACL', 'year': '2027',
                  'type': 'arr_direct_submission', 'at': exporter.aoe('2027-01-04')},
                 {'name': 'ICLR 2027', 'conference': 'ICLR', 'year': '2027', 'type': 'main_conference',
                  'at': exporter.aoe('2026-10-20')}]
submitted_may = [{'slot': 'submission', 'status': 'provided', 'provided_at': '2026-05-26T10:00:00Z'}]
for record, slots_, expected, due in [
    ({'venue': 'ARR Acceptance, Committed to EMNLP Findings'}, [], 'ARR → EMNLP Findings', None),
    ({'venue': 'ARR Acceptance, Committed to EMNLP, EMNLP 2026'}, submitted_may, 'ARR · May 2026 → EMNLP 2026', None),
    ({'venue': 'ARR Acceptance, Committed to EMNLP, EMNLP 2026'},
     [{'slot': 'submission', 'status': 'provided', 'provided_at': '2026-08-20T10:00:00Z'}], 'ARR → EMNLP 2026', None),
    ({'venue': 'ARR', 'venue_decision': 'accept', 'accepted_venue': 'ACL 2026'},
     [{'slot': 'submission', 'status': 'provided', 'provided_at': '2026-08-20T10:00:00Z'}], 'ARR → ACL 2026', None),
    ({'venue': 'EMNLP 2026', 'venue_decision': 'accept', 'accepted_venue': 'EMNLP', 'accepted_year': 2026,
      'artifacts': {'publication_track': 'findings'}}, [], 'ARR → EMNLP 2026 Findings', None),
    ({'venue': 'NAACL 2027 (main)', 'current_step': 'overleaf_writing'}, [], 'ARR · Oct 2026', 'ARR Oct 2026'),
    ({'venue': 'EACL 2027 (main)', 'current_step': 'overleaf_writing'}, [],
     'ARR · Oct 2026', 'ARR Oct 2026'),
    ({'venue': 'ARR October 2026', 'current_step': 'brainstorming_docs'}, [], 'ARR · Oct 2026', 'ARR Oct 2026'),
    ({'venue': 'Findings of ACL', 'current_step': 'arxiv_polish'}, [], 'ARR · cycle not recorded', None),
    ({'venue': 'ACL 2027', 'current_step': 'arxiv_polish'}, submitted_may, 'ARR · May 2026', None),
    ({'venue': 'iclr 2027', 'current_step': 'overleaf_writing'}, [], 'ICLR 2027', 'ICLR 2027'),
    ({'venue': 'NeurIPS 2026 (workshop)', 'current_step': 'poster_making'}, [], 'NeurIPS 2026 (workshop)', None),
    ({'venue': ''}, [], '', None)]:
    text, deadline = exporter.venue_info(record, slots_, ARR_DEADLINES, NOW)
    assert text == expected, (record, text)
    assert (deadline or {}).get('name') == due, (record, deadline)
# A cycle published later in the database is picked up without a code change.
later = exporter.venue_info({'venue': 'ACL 2027', 'current_step': 'overleaf_writing'}, [], ARR_DEADLINES,
                            exporter.parse_time('2026-10-14T00:00:00Z'))
assert later[0] == 'ARR · Jan 2027' and later[1]['name'] == 'ARR Jan 2027'
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
assert len(columns) == len(set(columns)) == len(exporter.PEOPLE_COLUMNS)
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
assert direct['data'][1]['values'][1][0] == '=IMPORTXML("private")'
print('PASS: direct database roster, all approved columns, explicit-ID aggregates, missing-value semantics, auth-secret exclusion')

refresh_spec = importlib.util.spec_from_file_location('refresh', Path(__file__).with_name('adminbot-sheet-refresh.py'))
refresh = importlib.util.module_from_spec(refresh_spec)
refresh_spec.loader.exec_module(refresh)
properties = {title: {'sheetId': sid, 'gridProperties': {'rowCount': 1000, 'columnCount': 131}}
              for title, sid in [('PeopleList', 1), ('PaperList', 2)]}
requests = refresh.refresh_requests(direct, properties)
clears = [r['repeatCell'] for r in requests if r.get('repeatCell', {}).get('fields', '').startswith('userEnteredValue')]
assert len(clears) == 2
assert {r['range']['sheetId'] for r in clears} == {1, 2}
assert len([r for r in requests if 'addTable' in r]) == 2
assert [r['range']['startRowIndex'] for r in clears] == [1, 0]
assert clears[1]['fields'] == 'userEnteredValue,userEnteredFormat'
assert len([r for r in requests if 'addFilterView' in r]) == 10
stage_view = next(r['addFilterView']['filter'] for r in requests
                  if r.get('addFilterView', {}).get('filter', {}).get('title') == 'By stage')
assert stage_view['sortSpecs'][0]['dimensionIndex'] == exporter.PAPERS.index('Stage')
assert exporter.PAPERS[:6] == ('Paper', 'Urgency', 'PI review', 'Review for', 'Review link', 'Due (Toronto)')
queue = next(r['addFilterView']['filter'] for r in requests
             if r.get('addFilterView', {}).get('filter', {}).get('title') == 'PI review queue')
assert queue['criteria'] == {str(exporter.PAPERS.index('PI review')): {'condition': {
    'type': 'TEXT_EQ', 'values': [{'userEnteredValue': 'Needs PI review'}]}}} and 'sortSpecs' not in queue
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
assert updated_table['columnProperties'][exporter.PAPERS.index('Stage')]['columnType'] == 'TEXT'  # No stage supplied in this synthetic row.
assert not any('deleteBanding' in r for r in converted)
paper_views = [r['addFilterView']['filter'] for r in converted if 'tableId' in r.get('addFilterView', {}).get('filter', {})]
assert [v['title'] for v in paper_views] == ['PaperList sort and filter', 'PI review queue', 'By review type', 'By venue', 'By stage']
assert all(v['tableId'] == 'paper-table' and 'range' not in v for v in paper_views)
properties['PaperList']['filterViews'] = [{'title': 'By stage', 'filterViewId': 43, 'tableId': 'paper-table'},
                                         {'title': 'Awaiting PI approval', 'filterViewId': 44, 'tableId': 'paper-table'}]
migrated = refresh.refresh_requests(direct, properties)
stage_update = next(r['updateFilterView'] for r in migrated
                    if r.get('updateFilterView', {}).get('filter', {}).get('filterViewId') == 43)
assert stage_update['fields'] == 'range,namedRangeId,tableId,sortSpecs'
assert stage_update['filter']['tableId'] == 'paper-table' and 'range' not in stage_update['filter']
assert {'deleteFilterView': {'filterId': 44}} in migrated  # obsolete view from the old layout
properties['PaperList']['filterViews'][0].pop('tableId')
recreated = refresh.refresh_requests(direct, properties)
assert {'deleteFilterView': {'filterId': 43}} in recreated
assert any(r.get('addFilterView', {}).get('filter', {}).get('title') == 'By stage' for r in recreated)
assert all(r.get('repeatCell', {}).get('range', {}).get('sheetId') == 2 for r in restyled
           if r.get('repeatCell', {}).get('fields', '').startswith('userEnteredFormat'))
paper_write = next(r['updateCells'] for r in requests if 'updateCells' in r and r['updateCells']['range']['sheetId'] == 2)
assert paper_write['rows'][1]['values'][0] == {'userEnteredValue': {'stringValue': '=IMPORTXML("private")'}}
invalid = json.loads(json.dumps(direct))
invalid['data'][0]['values'].append(invalid['data'][0]['values'][1])
try:
    refresh.refresh_requests(invalid, properties)
except ValueError:
    pass
else:
    raise AssertionError('Duplicate member accepted for publication')
print('PASS: atomic two-tab replacement, stale-row clearing, formula safety and duplicate rejection')

# One PI review queue: feedback requests (ARR / arXiv / other) and author sign-off, all in one column.
def slot(name, status='provided', at='2026-10-05T12:00:00Z', **extra):
    return {'slot': name, 'status': status, 'provided_at': at, 'provided_by_member_id': 'person',
            # link=/invalid= describe the slot itself; anything else (url, reason, deadlines) is the request payload.
            'invalid_reason': extra.pop('invalid', None), 'url': extra.pop('link', None),
            'value_text': json.dumps(extra) if extra else None}
members = {'person': {'name': 'Ada'}}
arr = exporter.paper_row({'id': 'a', 'title': 'A', 'venue': 'ACL 2027', 'current_step': 'submission'}, members,
    [slot('feedback_arr', url='https://www.overleaf.com/read/xyz', reason='Please check the intro',
          hard_deadline='2026-10-13T12:00:00Z')], [], NOW)
assert arr['PI review'] == 'Needs PI review' and arr['Review for'] == 'ARR feedback'
assert arr['Urgency'] == '🔴 Due in 2 days' and arr['Due (Toronto)'] == 'Tue Oct 13, 2026, 8:00 AM'
assert arr['Review link'] == [('Sent for review', 'https://www.overleaf.com/read/xyz')] and arr['Requested by'] == 'Ada'
assert arr['Request note'] == '[ARR feedback] Please check the intro', arr['Request note']
# The request's link is a known link: it keeps its real name, and edit + share + view all show once each.
edit, share, view = ('https://www.overleaf.com/project/abc', 'https://www.overleaf.com/123tok',
                     'https://www.overleaf.com/read/xyz')
same = exporter.paper_row({'id': 'e', 'title': 'E', 'venue': 'ACL 2027', 'current_step': 'overleaf_writing'}, members,
    [slot('feedback_arr', url=edit), slot('overleaf_edit', link=edit), slot('overleaf_share', link=share),
     slot('overleaf_view', link=view)], [], NOW)
assert same['Review link'] == [('Overleaf edit 🔒', edit), ('Overleaf share', share), ('Overleaf view', view)], same['Review link']
assert same['Link problems'] == ''  # the share and view links beside it open without an invitation
assert arr['Venue'] == 'ARR · Oct 2026', arr['Venue']
ack = exporter.paper_row({'id': 'b', 'title': 'B'}, members, [slot('authors_ack', at='2026-09-20T12:00:00Z'),
    slot('drive_pdf_arxiv', 'invalid', invalid='that is not a URL', link='someone@example.test')], [], NOW)
assert ack['Review for'] == 'Publication approval' and ack['Urgency'] == '🟠 Waiting 21 days'
assert ack['Link problems'] == 'PDF: that is not a URL' and ack['Review link'] == []
done = exporter.paper_row({'id': 'c', 'title': 'C'}, members, [slot('feedback_arxiv', at='2026-10-01T00:00:00Z'),
    slot('pi_approval', at='2026-10-02T00:00:00Z')], [], NOW)
assert done['PI review'] == 'Approved Thu Oct 1, 2026' and done['Urgency'] == '' and done['Review for'] == 'arXiv feedback'
again = exporter.paper_row({'id': 'd', 'title': 'D'}, members, [slot('feedback_other', at='2026-10-03T00:00:00Z'),
    slot('pi_approval', at='2026-10-02T00:00:00Z')], [], NOW)
assert again['PI review'] == 'Needs PI review' and again['Review for'] == 'Other feedback'
# Row-29 regression: share link stored in an invalid overleaf_edit slot and a /read/ view link both appear.
moral = exporter.paper_row({'id': 'e', 'title': 'E'}, members, [
    slot('overleaf_edit', 'invalid', invalid='the link must be a /project/ URL', link='https://www.overleaf.com/358abc#d4'),
    slot('overleaf_view', link='https://www.overleaf.com/read/hq#f7')], [], NOW)
assert moral['Review link'] == [('Overleaf edit', 'https://www.overleaf.com/358abc#d4'),
                                ('Overleaf view', 'https://www.overleaf.com/read/hq#f7')]
assert moral['Link problems'] == ''
deadline = []
pre = exporter.paper_row({'id': 'f', 'title': 'F', 'venue': 'NAACL 2027', 'current_step': 'overleaf_writing'},
                         members, [], deadline, NOW)
assert pre['Urgency'] == '🔴 Venue deadline in 2 days'
assert pre['Venue deadline (Toronto)'] == 'ARR Oct 2026: Tue Oct 13, 2026, 7:59 AM'
post = exporter.paper_row({'id': 'g', 'title': 'G', 'venue': 'NAACL 2027', 'current_step': 'poster_making'},
                          members, [], deadline, NOW)
assert post['Urgency'] == '' and post['Venue deadline (Toronto)'] == ''
order = sorted([post, pre, done, ack, arr], key=lambda r: r['_sort'])
assert [r['ID'] for r in order] == ['a', 'b', 'f', 'c', 'g'], [r['ID'] for r in order]
# ARR feedback with no date of its own inherits the ARR cycle deadline and outranks an older arXiv request.
arr_nodate = exporter.paper_row({'id': 'h', 'title': 'H', 'venue': 'NAACL 2027', 'current_step': 'overleaf_writing'},
                                members, [slot('feedback_arr', at='2026-10-10T00:00:00Z')], [], NOW)
arxiv_old = exporter.paper_row({'id': 'i', 'title': 'I'}, members, [slot('feedback_arxiv', at='2026-09-01T00:00:00Z')], [], NOW)
assert arr_nodate['Urgency'] == '🔴 ARR deadline in 2 days' and arxiv_old['Urgency'] == '🟠 Waiting 40 days'
assert sorted([arxiv_old, arr_nodate], key=lambda r: r['_sort'])[0]['ID'] == 'h'
both = exporter.paper_row({'id': 'j', 'title': 'J', 'venue': 'NAACL 2027', 'current_step': 'overleaf_writing'}, members,
                          [slot('feedback_arxiv', at='2026-10-09T00:00:00Z'), slot('feedback_arr', at='2026-10-10T00:00:00Z')], [], NOW)
assert both['Review for'] == 'ARR feedback, arXiv feedback' and both['Urgency'].startswith('🔴')
for r in (arr_nodate, arxiv_old, both):
    r.pop('_sort')
# Hard vs soft deadlines: hard is coloured and can go ⛔; soft alone is thin (◌) and ranks lower; both shows the soft as a note.
hard_late = exporter.paper_row({'id': 'k', 'title': 'K'}, members, [slot('feedback_other', soft_deadline='2026-10-08T16:00:00Z',
                                                                         hard_deadline='2026-10-09T16:00:00Z')], [], NOW)
assert hard_late['Urgency'] == '⛔ Hard deadline overdue by 2 days', hard_late['Urgency']
soft_only = exporter.paper_row({'id': 'l', 'title': 'L'}, members, [slot('feedback_other', soft_deadline='2026-10-13T16:00:00Z')], [], NOW)
assert soft_only['Urgency'] == '◌ Soft target in 2 days' and soft_only['Due (Toronto)'] == 'Soft target Tue Oct 13, 2026, 12:00 PM'
soft_late = exporter.paper_row({'id': 'm', 'title': 'M'}, members, [slot('feedback_other', soft_deadline='2026-10-09T16:00:00Z')], [], NOW)
assert soft_late['Urgency'] == '◌ Soft target passed 2 days ago'
two = exporter.paper_row({'id': 'n', 'title': 'N'}, members, [slot('feedback_arxiv', soft_deadline='2026-10-12T16:00:00Z',
                                                                   hard_deadline='2026-10-20T16:00:00Z')], [], NOW)
assert two['Urgency'] == '🟡 Due in 9 days · soft target tomorrow', two['Urgency']
assert two['Due (Toronto)'] == 'Tue Oct 20, 2026, 12:00 PM (soft target Mon Oct 12, 2026, 12:00 PM)'
ranked = sorted([soft_only, hard_late, two, soft_late], key=lambda r: r['_sort'])
assert [r['ID'] for r in ranked] == ['k', 'n', 'l', 'm'], [r['ID'] for r in ranked]
# arXiv feedback with no dates gets a review window before it counts as waiting.
arxiv_new = exporter.paper_row({'id': 'o', 'title': 'O'}, members, [slot('feedback_arxiv', at='2026-10-09T00:00:00Z')], [], NOW)
assert arxiv_new['Urgency'] == '◌ In 7-day review window: day 3', arxiv_new['Urgency']
assert sorted([arxiv_new, ack], key=lambda r: r['_sort'])[0]['ID'] == 'b'
# Venue deadlines by milestone: an abstract is a soft early deadline, submission is hard, notification is ignored.
def venue_d(day, milestone, label):
    return {'name': 'ICLR 2027', 'conference': 'ICLR', 'year': '2027', 'type': 'main_conference', 'milestone': milestone,
            'label': label, 'at': datetime.datetime.fromisoformat(day + 'T23:59').replace(tzinfo=ZoneInfo('Etc/GMT+12'))}
iclr = [venue_d('2026-10-13', 'abstract', 'Abstract'), venue_d('2026-10-20', 'submission', 'Paper submission'),
        venue_d('2026-10-12', 'notification_by', 'Notify authors by'), venue_d('2027-03-01', 'camera_ready', 'Camera-ready')]
early = exporter.paper_row({'id': 'q', 'title': 'Q', 'venue': 'ICLR 2027', 'current_step': 'overleaf_writing'}, members, [], iclr, NOW)
assert early['Urgency'] == '🟡 Venue deadline in 10 days · abstract in 3 days', early['Urgency']
assert early['Venue deadline (Toronto)'] == ('ICLR 2027 (Abstract): Wed Oct 14, 2026, 7:59 AM\n'
                                              'ICLR 2027: Wed Oct 21, 2026, 7:59 AM'), early['Venue deadline (Toronto)']
missed = exporter.paper_row({'id': 'r', 'title': 'R', 'venue': 'ICLR 2027', 'current_step': 'submission'}, members, [],
                            [venue_d('2026-10-05', 'submission', 'Paper submission')], NOW)
assert missed['Urgency'] == '⛔ Venue deadline overdue by 5 days', missed['Urgency']
camera = exporter.paper_row({'id': 's', 'title': 'S', 'venue': 'ICLR 2027', 'current_step': 'poster_making', 'venue_decision': 'accept',
                             'accepted_venue': 'ICLR', 'accepted_year': 2027}, members,
                            [slot('feedback_camera_ready', at='2026-10-10T00:00:00Z')], iclr, NOW)
assert camera['Urgency'] == '🟢 Camera-ready in 142 days', camera['Urgency']
assert camera['Venue deadline (Toronto)'] == 'ICLR 2027 (Camera-ready): Tue Mar 2, 2027, 6:59 AM'
for r in (hard_late, soft_only, soft_late, two, arxiv_new, early, missed, camera):
    r.pop('_sort')
# Restricted Overleaf links: a read link that no longer opens is flagged and locked; an open one is not.
read_ok, read_off = 'https://www.overleaf.com/read/okok', 'https://www.overleaf.com/read/offoff'
locked = exporter.paper_row({'id': 't', 'title': 'T'}, members, [slot('overleaf_view', link=read_off)], [], NOW,
                            {read_off: 'restricted', read_ok: 'open'})
assert locked['Review link'] == [('Overleaf view 🔒', read_off)]
assert locked['Link problems'] == 'Overleaf view: read link does not open (link sharing is off or the link was reset)'
opened = exporter.paper_row({'id': 'u', 'title': 'U'}, members, [slot('overleaf_view', link=read_ok)], [], NOW, {read_ok: 'open'})
assert opened['Review link'] == [('Overleaf view', read_ok)] and opened['Link problems'] == ''
for r in (locked, opened):
    r.pop('_sort')
assert [exporter.overleaf_kind(u) for u in ('https://www.overleaf.com/project/64ab', 'https://www.overleaf.com/read/ab12#x',
        'https://www.overleaf.com/3587461615abcdef', 'https://example.test/read/ab')] == ['project', 'read', 'edit', None]
import tempfile
with tempfile.TemporaryDirectory() as folder:
    cache = Path(folder) / 'cache.json'
    asked = []
    probe = lambda url: asked.append(url) or ('restricted' if 'off' in url else None if 'down' in url else 'open')
    links_ = [read_ok, read_off, 'https://www.overleaf.com/read/down', 'https://www.overleaf.com/project/x']
    assert exporter.overleaf_access(links_, cache, NOW, probe) == {read_ok: 'open', read_off: 'restricted'}
    assert 'okok' not in cache.read_text() and 'offoff' not in cache.read_text()  # only URL hashes on disk
    assert exporter.overleaf_access(links_, cache, NOW + datetime.timedelta(hours=1), probe) == {read_ok: 'open', read_off: 'restricted'}
    assert len(asked) == 4  # cached answers reused; the unanswered link is asked again
    busy = Path(folder) / 'busy.json'
    calls = []
    limited = lambda url: calls.append(url) or 'busy'
    assert exporter.overleaf_access(links_, busy, NOW, limited) == {} and len(calls) == 1  # stops at the first 429
print('PASS: unified PI queue, request deadlines/notes, approval resets, Overleaf share links, venue urgency, sort')
print('PASS: hard/soft/overdue urgency, arXiv review window, venue milestones and camera-ready, restricted Overleaf links')

for r in (arr, ack, done, again, moral, pre, post):
    r.pop('_sort')
c.execute('CREATE TABLE adminbot_paper_slots(paper_id TEXT, slot TEXT, status TEXT, provided_at TEXT, '
          'provided_by_member_id TEXT, invalid_reason TEXT, url TEXT, value_text TEXT)')
c.executemany('INSERT INTO adminbot_paper_slots VALUES (?,?,?,?,?,?,?,?)', [
    ('paper', 'drive_pdf_arxiv', 'provided', '2026-10-01', None, None, 'https://drive.google.com/file/d/pdf/view', None),
    ('paper', 'project_folder', 'provided', '2026-10-01', None, None, 'https://drive.google.com/drive/folders/folder', None),
    ('paper', 'arxiv_paper_password', 'provided', '2026-10-01', None, None, None, 'NEVER_EXPORT_PAPER_PASSWORD'),
    ('paper', 'feedback_arr', 'provided', '2026-10-01', 'new', None, None, json.dumps({'reason': 'check'})),
])
c.commit()
batch = exporter.snapshot(c, '2026-10-11T12:00:00+00:00')
linked = batch['data'][1]['values']
linked_row = dict(zip(linked[0], linked[1]))
link_row = dict(zip(linked[0], batch['paperLinks'][1]))
assert linked_row['Review link'] == 'PDF · Project folder'
assert link_row['Review link'] == [['PDF', 'https://drive.google.com/file/d/pdf/view'],
                                   ['Project folder', 'https://drive.google.com/drive/folders/folder']]
assert link_row['Paper'] == [] and linked_row['PI review'] == 'Needs PI review' and linked_row['Requested by'] == 'New person'
assert 'NEVER_EXPORT' not in json.dumps(batch)
styled = refresh.paper_style_requests(properties['PaperList'], linked, batch['paperLinks'])
link_cells = next(r['updateCells'] for r in styled if r.get('updateCells', {}).get('fields') == 'textFormatRuns')
runs = link_cells['rows'][0]['values'][0]['textFormatRuns']
assert [(r['startIndex'], r['format'].get('link', {}).get('uri')) for r in runs] == [
    (0, link_row['Review link'][0][1]), (3, None), (6, link_row['Review link'][1][1])]
assert linked_row['Review link'][6:] == 'Project folder'
assert refresh.link_runs([], {}) == []
hidden = {r['updateDimensionProperties']['range']['startIndex']: r['updateDimensionProperties']['properties']['hiddenByUser']
          for r in styled if 'hiddenByUser' in r.get('updateDimensionProperties', {}).get('properties', {})}
assert not hidden[exporter.PAPERS.index('Due (Toronto)')]  # core column, shown though empty
assert hidden[exporter.PAPERS.index('Accepted')] and not hidden[exporter.PAPERS.index('All artifact statuses')]
assert hidden[len(exporter.PAPERS)]  # leftover columns from the previous layout
print('PASS: label cells with separate hyperlinks, feedback-only value_text, core columns always visible')
noted = exporter.paper_row({'id': 'uka-clinical-post-training', 'title': 'U'}, members, [], [], NOW)
assert noted['Venue'] == 'Not ARR (per PI, Oct 11 2026)'
real = exporter.paper_row({'id': 'uka-clinical-post-training', 'title': 'U', 'venue': 'ICML 2027'}, members, [], [], NOW)
assert real['Venue'].startswith('ICML'), real['Venue']
print('PASS: sheet-only venue note fills a blank venue, a real AdminBot venue wins')

# OpenReview: forum id in a paper link wins, then title; a later cycle beats an earlier one; scores summarized.
results = [
    {'id': 'mayRun', 'forum': 'mayRun', 'title': 'Entropy Collapse in Agentic Social Media',
     'venue_id': 'aclweb.org/ACL/ARR/2026/May/Submission', 'status': 'rejected'},
    {'id': 'octRun', 'forum': 'octRun', 'title': 'Entropy Collapse in Agentic Social Media',
     'venue_id': 'aclweb.org/ACL/ARR/2026/October/Submission', 'status': 'under_review'},
    {'id': 'emnlp1', 'forum': 'emnlp1', 'review_forum': 'arr1', 'title': 'Other paper', 'venue': 'EMNLP 2026 Findings',
     'status': 'accepted', 'track': 'findings', 'presentation': 'poster',
     'reviews': [{'overall_assessment': 3.0}, {'overall_assessment': 3.5, 'soundness': 4.0}, {'confidence': 4.0}],
     'meta_review': {'overall_assessment': 3.5}},
    {'id': 'iclr1', 'forum': 'iclr1', 'title': 'Oral paper', 'venue': 'ICLR 2026 Oral', 'status': 'accepted',
     'track': 'main', 'presentation': 'oral', 'reviews': [{'rating': 8.0}, {'rating': 6.0}], 'error': 'timeout'},
]
entropy = {'title': 'Entropy collapse in agentic social-media!'}
assert exporter.openreview_match(entropy, [], results)['id'] == 'octRun'
linked = [{'slot': 'submission', 'url': 'https://openreview.net/forum?id=mayRun&noteId=x'}]
assert exporter.openreview_match(entropy, linked, results)['id'] == 'mayRun'
assert exporter.openreview_match({'title': 'x', 'artifacts': {'submission_url': 'https://openreview.net/forum?id=arr1'}},
                                 [], results)['id'] == 'emnlp1'
assert exporter.openreview_match({'title': 'Unknown'}, [], results) is None
assert exporter.openreview_text(results[1]) == '⏳ Under review · ARR October 2026'
assert exporter.openreview_text(results[2]) == (
    '✅ Accepted · Findings · Poster · EMNLP 2026 Findings · reviews 3 · 3.5 (avg 3.25) · meta 3.5')
assert exporter.openreview_text(results[3]) == (
    "✅ Accepted · Main · 🎤 Oral · ICLR 2026 Oral · reviews 8 · 6 (avg 7) · (reviews couldn't be read)")
assert exporter.openreview_text({'status': 'under_review', 'venue': 'Submitted to ICLR 2027'}) == '⏳ Under review · ICLR 2027'
assert exporter.openreview_text(None) == ''
assert exporter.venue_from_id('ICLR.cc/2027/Conference/Submission') == 'ICLR 2027'
assert exporter.venue_from_id('NeurIPS.cc/2026/Workshop/LLM_Agents/Submission') == 'NeurIPS 2026 Workshop LLM Agents'
assert exporter.load_openreview_results('/nonexistent/openreview.json') == []
# Fallback from the citation-check table, and the column + Accepted fill through a full snapshot.
connection = sqlite3.connect(':memory:')
connection.executescript('''
CREATE TABLE adminbot_lab_members (id TEXT, payload_json TEXT);
CREATE TABLE adminbot_papers (id TEXT, payload_json TEXT);
CREATE TABLE adminbot_openreview_citation_checks (submission_id TEXT, title TEXT, venue_id TEXT);
INSERT INTO adminbot_openreview_citation_checks VALUES
  ('octRun', 'Entropy Collapse in Agentic Social Media', 'aclweb.org/ACL/ARR/2026/October/Submission'),
  ('old', 'Gone', 'aclweb.org/ACL/ARR/2026/May/Withdrawn_Submission');
''')
connection.execute('INSERT INTO adminbot_papers VALUES (?,?)', ('p1', json.dumps({'id': 'p1', 'title': 'Entropy Collapse in Agentic Social Media'})))
connection.execute('INSERT INTO adminbot_papers VALUES (?,?)', ('p2', json.dumps({'id': 'p2', 'title': 'Oral paper'})))
connection.commit()
fallback = {e['id']: e['status'] for e in exporter.citation_check_results(connection)}
assert fallback == {'octRun': 'under_review', 'old': 'withdrawn'}, fallback
values = exporter.snapshot(connection, NOW.isoformat(), openreview=[results[3]])['data'][1]['values']
header = values[0]
rows = {row[header.index('Paper')]: row for row in values[1:]}
assert rows['Entropy Collapse in Agentic Social Media'][header.index('OpenReview')] == '⏳ Under review · ARR October 2026'
assert rows['Oral paper'][header.index('OpenReview')].startswith('✅ Accepted · Main · 🎤 Oral')
assert rows['Oral paper'][header.index('Accepted')] == 'ICLR 2026 Oral'
print('PASS: OpenReview column matches by forum then title, prefers the latest cycle, fills Accepted, falls back to citation checks')

# ARR feedback: done once the paper sits on the PI's OpenReview in a cycle closing after the request;
# a request whose ARR deadline went by stays listed but drops below live work.
LATER = exporter.parse_time('2026-10-24T12:00:00Z')
oct_submission = [{'id': 'octRun', 'title': 'Entropy', 'venue_id': 'aclweb.org/ACL/ARR/2026/October/Submission',
                   'status': 'under_review'}]
entropy = {'id': 'ent', 'title': 'Entropy', 'venue': 'ARR October 2026', 'current_step': 'submission'}
done = exporter.paper_row(entropy, members, [slot('feedback_arr', at='2026-10-06T12:00:00Z')], [], LATER,
                          openreview=oct_submission)
assert done['PI review'] == 'Submitted on OpenReview' and done['Urgency'] == '', done
assert done['_sort'][0] == 1
# A request for the next cycle, asked after the October one closed, is still open.
resubmit = exporter.paper_row(dict(entropy, venue='ARR January 2027'), members,
                              [slot('feedback_arr', at='2026-10-20T12:00:00Z')], [], LATER, openreview=oct_submission)
assert resubmit['PI review'] == 'Needs PI review' and resubmit['_sort'][0] == 0
# Not on OpenReview, own ARR date gone: listed as past, sorted after live requests.
missed = exporter.paper_row({'id': 'm', 'title': 'M', 'venue': 'ICLR 2027', 'current_step': 'overleaf_writing'}, members,
                            [slot('feedback_arr', hard_deadline='2026-10-13T12:00:00Z')], [], LATER)
assert missed['PI review'] == 'Past ARR deadline' and missed['Urgency'] == '⌛ ARR deadline passed Tue Oct 13, 2026'
# Dateless and the cycle closed since it was asked.
dateless = exporter.paper_row(dict(entropy, title='Other'), members, [slot('feedback_arr', at='2026-10-06T12:00:00Z')],
                              [], LATER)
assert dateless['PI review'] == 'Past ARR deadline', dateless['Urgency']
live = exporter.paper_row({'id': 'l', 'title': 'L', 'venue': 'ICLR 2027', 'current_step': 'overleaf_writing'}, members,
                          [slot('feedback_other', at='2026-10-20T12:00:00Z')], [], LATER)
assert sorted([missed['_sort'], live['_sort']])[0] == live['_sort']
assert exporter.PAPERS.index('Authors') == exporter.PAPERS.index('Due (Toronto)') + 1
print('PASS: ARR feedback settled by an OpenReview submission, past-deadline ARR requests sink, Authors beside Due')
