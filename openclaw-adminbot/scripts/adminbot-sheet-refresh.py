#!/usr/bin/env python3
"""Operator-approved six-hourly (Toronto time) database export to exactly two protected sheet tabs."""
import argparse
import datetime
import importlib.util
import json
import re
import os
import shlex
import sqlite3
import subprocess
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('exporter', Path(__file__).with_name('adminbot-sheet-export.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

URGENCY_COLOURS = {'⛔': {'red': .96, 'green': .73, 'blue': .73}, '🔴': {'red': .99, 'green': .87, 'blue': .87}, '🟠': {'red': 1, 'green': .92, 'blue': .82},
                   '🟡': {'red': 1, 'green': .97, 'blue': .80}, '🟢': {'red': .89, 'green': .96, 'blue': .89}}
# What the PI reads first; always visible even when empty.
PAPER_CORE = exporter.PAPERS[:exporter.PAPERS.index('Blocker / next step') + 1]
# The frozen title stays narrow enough to leave room for the next columns on a phone.
PAPER_WIDTHS = {'Paper': 260, 'Urgency': 190, 'PI review': 150, 'Review for': 170, 'Review link': 280,
                'Due (Toronto)': 170, 'Requested by': 150, 'Requested on': 130, 'Request note': 320,
                'Venue deadline (Toronto)': 260, 'OpenReview': 300, 'Stage': 170, 'Lead': 150,
                'Incomplete': 260, 'Blocker / next step': 280, 'Link problems': 240, 'Still missing': 260, 'Authors': 360,
                'All artifact statuses': 300, 'Venue (as entered)': 220, 'Venue': 230, 'Conference': 150, 'Checks': 240, exporter.PAPER_ID: 160,
                'Paper state': 190, 'Year': 70, 'Track': 100, 'Presentation': 110, 'Submission history': 280, 'Source': 200,
                'tweet tags to copy': 420}
# Columns with a closed set of values get a dropdown of the values in use, so each filters by picking one.
PAPER_DROPDOWNS = ('Stage', 'Paper state', 'Conference', 'Year', 'Track', 'Presentation', 'Source')


# PI review values drawn in bold red: the PI acts, or somebody must fix the link or the category.
ATTENTION_STATUSES = ('Needs PI review', 'Blocked: link access', 'Other')


PEOPLE_WIDTHS = {'name': 190, 'search': 220, 'research_topics': 260, 'elevator_pitch': 260, 'projects': 220,
                 'papers_authored': 300, 'affiliation': 200, 'availability_notes': 240, 'time_off': 200,
                 'email': 210, 'calendar_email': 210, 'correspondence_email': 210, 'location': 180, 'role': 160}
# Header colour per PeopleList section, so the eye finds Contact or Links without reading every header.
PEOPLE_SECTION_COLOURS = {
    'Contact': {'red': .13, 'green': .37, 'blue': .45}, 'Lab': {'red': .18, 'green': .29, 'blue': .40},
    'Research': {'red': .35, 'green': .26, 'blue': .49}, 'Links & socials': {'red': .16, 'green': .42, 'blue': .30},
    'Location & availability': {'red': .55, 'green': .35, 'blue': .13}, 'Search': {'red': .40, 'green': .45, 'blue': .51},
    exporter.PEOPLE_RECORDS_SECTION: {'red': .45, 'green': .49, 'blue': .54}}
PEOPLE_EMAILS = ('email', 'calendar_email', 'correspondence_email')
PEOPLE_URLS = ('personal_website', 'linkedin_url', 'twitter_url', 'github_url', 'scholar_url',
               'acl_anthology_url', 'lesswrong_url', 'cv_url', 'intake_form_url', 'availability_doc_url')


LINK_URL = re.compile(r"https?://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?([/?#][A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*)?")
LINK_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")


def people_link(field, text):
    """Where a PeopleList cell should open, or None. Only a cell that is one address becomes a link."""
    text = text.strip()
    if not text or any(c.isspace() for c in text):
        return None
    # Google rejects the whole batch for one malformed link, so anything unusual stays plain text.
    if field in PEOPLE_URLS and LINK_URL.fullmatch(text):
        return text
    if field in PEOPLE_EMAILS and LINK_EMAIL.fullmatch(text):
        return 'mailto:' + text
    if field == 'openreview_id' and text.startswith('~'):
        return 'https://openreview.net/profile?id=' + text
    return None


def whatsapp_link(text):
    digits = ''.join(c for c in text if c.isdigit())
    return 'https://wa.me/' + digits if text.strip().startswith('+') and 8 <= len(digits) <= 15 else None


def column_group_requests(properties, start, end):
    """One collapsible group over the secondary columns, collapsed only when it is first made.

    Later refreshes leave an existing group alone, so whoever expanded it keeps it expanded.
    """
    sid = properties['sheetId']
    groups = properties.get('columnGroups', [])
    if any(g['range'].get('startIndex') == start and g['range'].get('endIndex') == end and g.get('depth') == 1
           for g in groups):
        return []
    span = {'sheetId': sid, 'dimension': 'COLUMNS', 'startIndex': start, 'endIndex': end}
    requests = [{'deleteDimensionGroup': {'range': {**g['range'], 'sheetId': sid}}}
                for g in sorted(groups, key=lambda g: -g.get('depth', 1))]
    return requests + [
        {'updateDimensionProperties': {'range': span, 'properties': {'hiddenByUser': False}, 'fields': 'hiddenByUser'}},
        {'addDimensionGroup': {'range': span}},
        {'updateDimensionGroup': {'dimensionGroup': {'range': span, 'depth': 1, 'collapsed': True},
                                  'fields': 'collapsed'}},
    ]


def people_style_requests(properties, values, fields):
    """Sectioned, readable PeopleList: coloured section headers, clickable contacts, one [+] group for the rest.

    values carries the header labels; fields is the same columns as database field names.
    """
    sid = properties['sheetId']
    row_count = len(values)
    core = len([field for field in exporter.PEOPLE_PRIORITY if field in fields])
    area = {'sheetId': sid, 'startRowIndex': 0, 'endRowIndex': row_count, 'startColumnIndex': 0,
            'endColumnIndex': len(fields)}
    muted = {'red': .42, 'green': .47, 'blue': .53}
    requests = [
        {'repeatCell': {'range': {**area, 'startRowIndex': 1}, 'cell': {'userEnteredFormat': {
            'textFormat': {'fontFamily': 'Arial', 'fontSize': 10, 'bold': False,
                           'foregroundColor': {'red': .15, 'green': .19, 'blue': .24}},
            'verticalAlignment': 'MIDDLE', 'wrapStrategy': 'CLIP'}},
            'fields': 'userEnteredFormat.textFormat,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy'}},
        {'repeatCell': {'range': {**area, 'startRowIndex': 1, 'endColumnIndex': 1}, 'cell': {'userEnteredFormat': {
            'textFormat': {'bold': True}}}, 'fields': 'userEnteredFormat.textFormat.bold'}},
        {'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'ROWS', 'startIndex': 0, 'endIndex': 1},
            'properties': {'pixelSize': 40}, 'fields': 'pixelSize'}},
        {'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'ROWS', 'startIndex': 1, 'endIndex': row_count},
            'properties': {'pixelSize': 26}, 'fields': 'pixelSize'}},
        {'updateSheetProperties': {'properties': {'sheetId': sid, 'gridProperties': {'hideGridlines': True}},
            'fields': 'gridProperties.hideGridlines'}},
        {'updateCells': {'range': {**area, 'endRowIndex': 1}, 'rows': [{'values': [
            {'userEnteredFormat': {'backgroundColor': PEOPLE_SECTION_COLOURS[exporter.people_section(field)],
                                   'textFormat': {'fontFamily': 'Arial', 'fontSize': 10, 'bold': True,
                                                  'foregroundColor': {'red': 1, 'green': 1, 'blue': 1}},
                                   'verticalAlignment': 'MIDDLE', 'wrapStrategy': 'WRAP'},
             'note': exporter.people_section(field) + (f' · {field}' if exporter.people_label(field) != field else '')}
            for field in fields]}],
            'fields': 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,'
                      'userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy,note'}},
    ]
    if 'search' in fields:
        index = fields.index('search')
        requests.append({'repeatCell': {'range': {**area, 'startRowIndex': 1, 'startColumnIndex': index,
                                                  'endColumnIndex': index + 1},
            'cell': {'userEnteredFormat': {'textFormat': {'fontSize': 9, 'foregroundColor': muted}}},
            'fields': 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.foregroundColor'}})
    link_style = {'underline': True, 'foregroundColor': {'red': .12, 'green': .34, 'blue': .67}}
    for index, field in enumerate(fields):
        requests.append({'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'COLUMNS',
            'startIndex': index, 'endIndex': index + 1}, 'properties': {'pixelSize': PEOPLE_WIDTHS.get(field, 140)},
            'fields': 'pixelSize'}})
        if field in PEOPLE_URLS + PEOPLE_EMAILS + ('openreview_id', 'whatsapp'):
            # Every row is rewritten, so a link never stays on a cell after its person moved rows.
            targets = [whatsapp_link(str(row[index])) if field == 'whatsapp' else people_link(field, str(row[index]))
                       for row in values[1:]]
            requests.append({'updateCells': {'range': {**area, 'startRowIndex': 1, 'startColumnIndex': index,
                                                       'endColumnIndex': index + 1},
                'rows': [{'values': [{'textFormatRuns': [{'startIndex': 0, 'format': {**link_style, 'link': {'uri': url}}}]
                                      if url else []}]} for url in targets],
                'fields': 'textFormatRuns'}})
    if core < len(fields):
        requests += column_group_requests(properties, core, len(fields))
    return requests


def status_note(counts):
    """Header note on 'PI review': how many papers carry each value; Other means a rule is missing."""
    lines = [f'{value}: {counts[value]}' for value in exporter.PI_REVIEW_VALUES if counts.get(value)]
    if counts.get('Other'):
        lines.append('Other = no standard status fits; add a rule in PI_REVIEW_RULES.')
    return 'Papers by PI review status\n' + '\n'.join(lines)


def column_range(area, name, start_row=1):
    index = exporter.PAPERS.index(name)
    return {**area, 'startRowIndex': start_row, 'startColumnIndex': index, 'endColumnIndex': index + 1}


def link_runs(pairs, style):
    """One clickable run per label in 'A · B · C'; separators stay plain. Indexes match the cell text exactly."""
    runs, position = [], 0
    for number, (label, url) in enumerate(pairs):
        if number:
            runs.append({'startIndex': position, 'format': {}})
            position += len(exporter.LINK_SEPARATOR.encode('utf-16-le')) // 2
        runs.append({'startIndex': position, 'format': {**style, 'link': {'uri': url}}})
        position += len(label.encode('utf-16-le')) // 2
    return runs


def paper_style_requests(properties, values, links, counts=None):
    sid = properties['sheetId']
    row_count = len(values)
    headers = list(exporter.PAPERS)
    area = {'sheetId': sid, 'startRowIndex': 0, 'endRowIndex': row_count,
            'startColumnIndex': 0, 'endColumnIndex': len(headers)}
    requests = [
        {'repeatCell': {'range': area, 'cell': {'userEnteredFormat': {
            'textFormat': {'fontFamily': 'Arial', 'fontSize': 10, 'bold': False,
                           'foregroundColor': {'red': .15, 'green': .19, 'blue': .24}},
            'verticalAlignment': 'TOP', 'wrapStrategy': 'WRAP'}},
            'fields': 'userEnteredFormat.textFormat,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy'}},
        {'repeatCell': {'range': {**area, 'endRowIndex': 1}, 'cell': {'userEnteredFormat': {
            'textFormat': {'fontFamily': 'Arial', 'fontSize': 11, 'bold': True,
                           'foregroundColor': {'red': 1, 'green': 1, 'blue': 1}},
            'verticalAlignment': 'MIDDLE'}},
            'fields': 'userEnteredFormat.textFormat,userEnteredFormat.verticalAlignment'}},
        {'repeatCell': {'range': column_range(area, 'Paper'), 'cell': {'userEnteredFormat': {'textFormat': {'bold': True}}},
            'fields': 'userEnteredFormat.textFormat.bold'}},
        {'repeatCell': {'range': column_range(area, exporter.PAPER_ID), 'cell': {'userEnteredFormat': {
            'wrapStrategy': 'CLIP', 'textFormat': {'fontSize': 9, 'foregroundColor': {'red': .42, 'green': .47, 'blue': .53}}}},
            'fields': 'userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.foregroundColor'}},
        {'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'ROWS', 'startIndex': 0, 'endIndex': 1},
            'properties': {'pixelSize': 36}, 'fields': 'pixelSize'}},
        # Long notes remain in the cell; a bounded row height keeps the PI's overview scannable.
        {'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'ROWS', 'startIndex': 1, 'endIndex': row_count},
            'properties': {'pixelSize': 60}, 'fields': 'pixelSize'}},
        {'updateSheetProperties': {'properties': {'sheetId': sid, 'gridProperties': {'hideGridlines': True}},
            'fields': 'gridProperties.hideGridlines'}},
    ]
    core = len(PAPER_CORE)
    grouping = column_group_requests(properties, core, len(headers))
    for index, name in enumerate(headers):
        empty = not any(str(row[index]).strip() for row in values[1:])
        # Inside the [+] group only empty columns are hidden; showing the rest is the group's job.
        hidden = name not in PAPER_CORE and empty
        fields = 'pixelSize,hiddenByUser' if index < core or hidden else 'pixelSize'
        requests.append({'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'COLUMNS',
            'startIndex': index, 'endIndex': index + 1}, 'properties': {
                'pixelSize': PAPER_WIDTHS.get(name, 120 if name in exporter.LINK_COLUMNS else 160),
                'hiddenByUser': hidden},
            'fields': fields}})
        if index == core - 1:
            requests += grouping
    # Columns left over from the previous, wider layout.
    if properties['gridProperties']['columnCount'] > len(headers):
        requests.append({'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'COLUMNS',
            'startIndex': len(headers), 'endIndex': properties['gridProperties']['columnCount']},
            'properties': {'hiddenByUser': True}, 'fields': 'hiddenByUser'}})
    link_colour = {'underline': True, 'foregroundColor': {'red': .12, 'green': .34, 'blue': .67}}
    for name in exporter.LINK_COLUMNS:
        index = headers.index(name)
        requests.append({'updateCells': {'range': column_range(area, name),
            'rows': [{'values': [{'textFormatRuns': link_runs(row[index], link_colour)}]} for row in links[1:]],
            'fields': 'textFormatRuns'}})
    urgency, review = headers.index('Urgency'), headers.index('PI review')
    requests.append({'updateCells': {'range': {**area, 'startRowIndex': 1, 'startColumnIndex': urgency,
                                               'endColumnIndex': review + 1},
        'rows': [{'values': [
            {'userEnteredFormat': {'backgroundColor': URGENCY_COLOURS[row[urgency][:1]], 'textFormat': {'bold': True}}}
            if row[urgency][:1] in URGENCY_COLOURS else {},
            {'userEnteredFormat': {'textFormat': {'bold': True, 'foregroundColor': {'red': .70, 'green': .11, 'blue': .11}}}}
            if exporter.status_kind(row[review]) in ATTENTION_STATUSES else {}]} for row in values[1:]],
        'fields': 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColor'}})
    requests.append({'updateCells': {'range': {**area, 'startRowIndex': 0, 'endRowIndex': 1,
                                               'startColumnIndex': review, 'endColumnIndex': review + 1},
        'rows': [{'values': [{'note': status_note(counts or {})}]}], 'fields': 'note'}})
    requests.append({'updateCells': {'range': column_range(area, 'tweet tags to copy', 0) | {'endRowIndex': 1},
        'rows': [{'values': [{'note': 'Copyable public links and credits, not a complete tweet. '
            'Author order is preserved. Untagged names have no unambiguous stored X handle. '
            'Affiliations are PI-supplied and are not funding/support credits. '
            'Review before posting; split long credits across posts.'}]}], 'fields': 'note'}})
    return requests


# Read by the AdminBot service's paper nudge: the links each paper's authors must fix so the PI can
# open them. Next to the database, where the setgid state directory makes it group-readable.
LINK_PROBLEMS_FILE = 'paper-link-problems.json'


def write_link_problems(path, problems, timestamp):
    """Replace path atomically with {generated_at, papers: {paper id: [problem, ...]}}; mode 640."""
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, 'w') as handle:
        json.dump({'generated_at': timestamp, 'papers': problems}, handle, sort_keys=True)
    os.chmod(temporary, 0o640)
    temporary.replace(path)


def sheet_values(title, values):
    """The cells as written: PeopleList shows header labels in place of database field names."""
    if title != 'PeopleList':
        return values
    return [[exporter.people_label(field) for field in values[0]], *values[1:]]


def refresh_requests(batch, properties):
    requests = []
    expected = [exporter.ordered_people_columns(exporter.PEOPLE_COLUMNS), list(exporter.PAPERS)]
    for item, headers in zip(batch['data'], expected, strict=True):
        title = item['range'].split("'")[1]
        values = item['values']
        if values[0] != headers or len(values) < 2:
            raise ValueError('Unexpected headers or empty export; previous snapshot retained')
        if any(len(row) != len(headers) or any(len(str(value)) > 50000 for value in row) for row in values):
            raise ValueError('Invalid export dimensions or oversized cell')
        id_column = headers.index(exporter.PAPER_ID if title == 'PaperList' else 'id')
        ids = [row[id_column] for row in values[1:]]
        if not all(ids) or len(ids) != len(set(ids)):
            raise ValueError('Missing or duplicate record IDs')
        field_names = headers
        values = sheet_values(title, values)
        headers = values[0]
        label = exporter.people_label if title == 'PeopleList' else str
        p = properties[title]
        sid = p['sheetId']
        grid = p['gridProperties']
        requests.extend([
            {'updateSheetProperties': {'properties': {'sheetId': sid, 'gridProperties': {
                'rowCount': max(grid['rowCount'], len(values)),
                'columnCount': max(grid['columnCount'], len(headers)),
                'frozenRowCount': 1, 'frozenColumnCount': 1}},
                'fields': 'gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.frozenColumnCount'}},
            # Clear and write are in one atomic batch: deleted records cannot linger.
            # PaperList also drops old formats so hyperlinks from a previous layout cannot sit on new data.
            {'repeatCell': {'range': {'sheetId': sid, 'startRowIndex': 0 if title == 'PaperList' else 1}, 'cell': {},
                'fields': 'userEnteredValue,userEnteredFormat' if title == 'PaperList' else 'userEnteredValue'}},
            {'updateCells': {'range': {'sheetId': sid, 'startRowIndex': 0, 'endRowIndex': len(values),
                'startColumnIndex': 0, 'endColumnIndex': len(headers)},
                'rows': [{'values': [{'userEnteredValue': {'stringValue': str(value)}} for value in row]} for row in values],
                'fields': 'userEnteredValue'}},
        ])
        table_range = {'sheetId': sid, 'startRowIndex': 0, 'endRowIndex': len(values),
                       'startColumnIndex': 0, 'endColumnIndex': len(headers)}
        tables = p.get('tables', [])
        if len(tables) > 1 or (tables and tables[0]['name'] != title):
            raise ValueError('Unexpected export table identity')
        columns = [{'columnIndex': i, 'columnName': name, 'columnType': 'TEXT'}
                   for i, name in enumerate(headers)]
        for name in PAPER_DROPDOWNS if title == 'PaperList' else ('status',):
            index = headers.index(label(name))
            options = sorted({row[index] for row in values[1:] if row[index]})
            if options:
                columns[index].update(columnType='DROPDOWN', dataValidationRule={'condition': {
                    'type': 'ONE_OF_LIST', 'values': [{'userEnteredValue': value} for value in options]}})
        table = {'name': title, 'range': table_range, 'columnProperties': columns,
                 'rowsProperties': {
                     'headerColorStyle': {'rgbColor': {'red': .18, 'green': .29, 'blue': .40}},
                     'firstBandColorStyle': {'rgbColor': {'red': 1, 'green': 1, 'blue': 1}},
                     'secondBandColorStyle': {'rgbColor': {'red': .97, 'green': .98, 'blue': .99}}}}
        if tables:
            requests.append({'updateTable': {'table': {**table, 'tableId': tables[0]['tableId']},
                'fields': 'range,columnProperties,rowsProperties'}})
        else:
            requests.append({'clearBasicFilter': {'sheetId': sid}})
            requests.extend({'deleteBanding': {'bandedRangeId': band['bandedRangeId']}}
                            for band in p.get('bandedRanges', []))
            requests.append({'addTable': {'table': table}})
        views = [(title + ' sort and filter', None, None)]
        if title == 'PaperList':
            for obsolete in ('Awaiting PI approval', 'By PI approval', 'By review category'):
                requests.extend({'deleteFilterView': {'filterId': v['filterViewId']}}
                                for v in p.get('filterViews', []) if v['title'] == obsolete)
            # The export is already ordered by urgency, so the queue view only filters.
            views += [('PI review queue', None, ('PI review', 'Needs PI review')), ('Incomplete', None, ('Incomplete', None)),
                      ('By PI review status', 'PI review', None), ('By review type', 'Review for', None),
                      ('By conference', 'Conference', None), ('By venue', 'Venue', None), ('By stage', 'Stage', None),
                      ('Blocked', None, ('PI review', 'Blocked: link access')), ('By paper state', 'Paper state', None),
                      ('By year', 'Year', None), ('By track', 'Track', None)]
        else:
            views += [('Full members', None, ('member_type', 'full', 'TEXT_CONTAINS')),
                      ('By joined date', 'join_date', None),
                      ('Review inactive members', 'membership_review', ('membership_review', 'Review inactive')),
                      ('By membership type', 'member_type', None)]
            requests.extend({'deleteFilterView': {'filterId': v['filterViewId']}}
                            for v in p.get('filterViews', []) if v['title'] == 'By Slack active channel')
        for view_title, sort_column, criterion in views:
            view = next((v for v in p.get('filterViews', []) if v['title'] == view_title), None)
            if view and tables and view.get('tableId') != tables[0]['tableId']:
                # Sheets does not convert a range-backed view into a table view in place.
                requests.append({'deleteFilterView': {'filterId': view['filterViewId']}})
                view = None
            specification = {'tableId': tables[0]['tableId']} if tables else {'range': table_range}
            fields = 'range,namedRangeId,tableId' if tables else 'range'
            if sort_column:
                specification['sortSpecs'] = [{'dimensionIndex': headers.index(label(column)), 'sortOrder': 'ASCENDING'}
                                              for column in [sort_column, 'Paper' if title == 'PaperList' else 'name']]
                fields += ',sortSpecs'
            if criterion:
                kind = criterion[2] if len(criterion) > 2 else 'TEXT_EQ'
                specification['criteria'] = {str(headers.index(label(criterion[0]))): {'condition': {
                    'type': kind, 'values': [{'userEnteredValue': criterion[1]}]} if criterion[1] else {
                    'type': 'NOT_BLANK'}}}
                fields += ',criteria'
            if view:
                requests.append({'updateFilterView': {'filter': {**specification, 'filterViewId': view['filterViewId']},
                    'fields': fields}})
            else:
                requests.append({'addFilterView': {'filter': {**specification, 'title': view_title}}})
        if title == 'PeopleList':
            # The header row is kept for the table; headers of columns a narrower export dropped are blanked
            # here, once the table no longer spans them.
            requests.append({'repeatCell': {'range': {'sheetId': sid, 'startRowIndex': 0, 'endRowIndex': 1,
                'startColumnIndex': len(headers)}, 'cell': {}, 'fields': 'userEnteredValue,userEnteredFormat,note'}})
            requests.extend(people_style_requests(p, values, field_names))
        if title == 'PaperList':
            requests.extend(paper_style_requests(p, values, batch['paperLinks'], batch.get('statusCounts')))
    return requests



def editor_requests(sheets, writer, wanted):
    """Add the approved editors to every protection the bot itself may edit, on every tab.

    A protection the bot is not an editor of (owner-only) cannot be changed by it; those are
    returned by title so the run can report them instead of failing.
    """
    requests, locked = [], []
    for sheet in sheets:
        for protection in sheet.get('protectedRanges', []):
            if protection.get('warningOnly'):
                continue
            users = protection.get('editors', {}).get('users', [])
            present = {email.lower() for email in users}
            missing = [email for email in wanted if email.lower() not in present]
            if not missing:
                continue
            if writer not in present:
                locked.append(sheet['properties']['title'])
                continue
            requests.append({'updateProtectedRange': {'protectedRange': {
                'protectedRangeId': protection['protectedRangeId'],
                'editors': {**protection.get('editors', {}), 'users': users + missing}}, 'fields': 'editors'}})
    return requests, sorted(set(locked))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--gog', required=True)
    parser.add_argument('--status', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    env = os.environ.copy()
    # Only Google identity/keyring variables reach the child, not other service secrets.
    for line in Path(args.env_file).read_text().splitlines():
        line = line.strip().removeprefix('export ')
        if '=' in line:
            key, value = line.split('=', 1)
            if key in ('GOG_ACCOUNT', 'GOG_KEYRING_PASSWORD'):
                env[key] = shlex.split(value)[0]
    env['GOG_KEYRING_BACKEND'] = 'file'
    writer = env.get('GOG_ACCOUNT', '').lower()
    if writer != 'jinesis.adminbot@gmail.com':
        raise ValueError('Unexpected Google writer identity')

    def gog(arguments, timeout=60):
        result = subprocess.run([args.gog, '--no-input', '--json', *arguments], env=env,
                                capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            # CLI stderr may contain credentials or fetched content; never log it.
            raise RuntimeError('Google CLI exit ' + str(result.returncode))
        return json.loads(result.stdout)

    spreadsheet = config['spreadsheet_id']
    ownership = gog(['--readonly', 'api', 'call', 'drive', 'v3', 'drive.files.get',
        '--params', json.dumps({'fileId': spreadsheet, 'fields': 'owners(emailAddress)'})])
    allowed_editors = {writer} | {owner['emailAddress'].lower() for owner in ownership['owners']}
    # Named people the operator approved as protected-tab editors; anyone else still stops the export.
    allowed_editors |= {email.lower() for email in config.get('extra_protection_editors', [])}
    metadata = gog(['--readonly', 'api', 'call', 'sheets', 'v4', 'sheets.spreadsheets.get',
        '--params', json.dumps({'spreadsheetId': spreadsheet, 'fields': 'sheets(properties,protectedRanges,filterViews,bandedRanges,tables,columnGroups)'})])
    properties = {}
    for title, key in [('PeopleList', 'people_sheet_id'), ('PaperList', 'papers_sheet_id')]:
        sheet = next(s for s in metadata['sheets'] if s['properties']['title'] == title)
        sid = config[key]
        if sheet['properties']['sheetId'] != sid:
            raise ValueError('Configured tab identity changed')
        if not any(p['range'] == {'sheetId': sid} and not p.get('warningOnly', False)
                   and writer in {email.lower() for email in p.get('editors', {}).get('users', [])}
                   and {email.lower() for email in p.get('editors', {}).get('users', [])} <= allowed_editors
                   and not p.get('editors', {}).get('groups')
                   and not p.get('editors', {}).get('domainUsersCanEdit')
                   for p in sheet.get('protectedRanges', [])):
            raise ValueError('Whole-tab export protection missing or changed')
        properties[title] = {**sheet['properties'], 'filterViews': sheet.get('filterViews', []),
                             'bandedRanges': sheet.get('bandedRanges', []), 'tables': sheet.get('tables', []),
                             'columnGroups': sheet.get('columnGroups', [])}
    # Keep the approved editors on the file and on every protected tab, so access never drifts and
    # nobody has to re-share by hand. Sharing is sent without notification emails.
    wanted = [email.lower() for email in config.get('extra_protection_editors', [])]
    editor_sync = {'locked_tabs': [], 'failed': False}
    try:
        shared = gog(['--readonly', 'api', 'call', 'drive', 'v3', 'drive.permissions.list',
            '--params', json.dumps({'fileId': spreadsheet, 'fields': 'permissions(emailAddress,role)'})])
        roles = {(p.get('emailAddress') or '').lower(): p.get('role') for p in shared.get('permissions', [])}
        for email in wanted:
            if roles.get(email) not in ('writer', 'owner'):
                gog(['api', 'call', 'drive', 'v3', 'drive.permissions.create', '--params',
                     json.dumps({'fileId': spreadsheet, 'sendNotificationEmail': False}), '--body',
                     json.dumps({'type': 'user', 'role': 'writer', 'emailAddress': email}), '--allow-write', '--force'])
        protections, editor_sync['locked_tabs'] = editor_requests(metadata['sheets'], writer, wanted)
        if protections:
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as body:
                json.dump({'requests': protections}, body)
                body.flush()
                gog(['api', 'call', 'sheets', 'v4', 'sheets.spreadsheets.batchUpdate', '--params',
                     json.dumps({'spreadsheetId': spreadsheet}), '--body', '@' + body.name, '--allow-write', '--force'])
    except (RuntimeError, ValueError, subprocess.TimeoutExpired):
        editor_sync['failed'] = True
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with sqlite3.connect(Path(args.database).resolve().as_uri() + '?mode=ro', uri=True, timeout=15) as connection:
        connection.execute('PRAGMA query_only=ON')
        urls = exporter.overleaf_urls(connection)
    # Logged-out Overleaf check of read links, cached for a day next to the status file; failures report nothing.
    try:
        access = exporter.overleaf_access(urls, Path(args.status).with_name('adminbot-overleaf-access-cache.json'),
                                          exporter.parse_time(timestamp))
    except OSError:
        access = {}
    with sqlite3.connect(Path(args.database).resolve().as_uri() + '?mode=ro', uri=True, timeout=15) as connection:
        connection.execute('PRAGMA query_only=ON')
        # Written every six hours by the OpenReview results job under the account that holds the login;
        # absent is fine (the citation-check table is the fallback). The PI's notification e-mails are
        # not read: they froze each paper at the title and status they were sent with.
        openreview = exporter.load_openreview_results(Path(args.database).with_name('openreview-author-results.json'))
        batch = exporter.snapshot(connection, timestamp, full_people=True, link_access=access, openreview=openreview)
    requests = refresh_requests(batch, properties)
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as body:
        json.dump({'requests': requests}, body)
        body.flush()
        gog(['api', 'call', 'sheets', 'v4', 'sheets.spreadsheets.batchUpdate', '--params',
             json.dumps({'spreadsheetId': spreadsheet}), '--body', '@' + body.name, '--allow-write', '--force'])
    counts = []
    for item in batch['data']:
        title = item['range'].split("'")[1]
        values = sheet_values(title, item['values'])
        width = len(values[0])
        end = ''
        while width:
            width, remainder = divmod(width - 1, 26)
            end = chr(65 + remainder) + end
        actual = gog(['--readonly', 'sheets', 'get', spreadsheet, f"'{title}'!A1:{end}{len(values) + 1}"])['values']
        actual = [row + [''] * (len(values[0]) - len(row)) for row in actual]
        if actual != values:
            raise RuntimeError('Export readback did not match database snapshot')
        counts.append(len(values) - 1)
    write_link_problems(Path(args.database).with_name(LINK_PROBLEMS_FILE), batch['linkProblems'], timestamp)
    status = Path(args.status)
    temporary = status.with_suffix('.tmp')
    temporary.write_text(json.dumps({'last_success_utc': timestamp,
        'member_rows': counts[0], 'paper_rows': counts[1], 'spreadsheet_id': spreadsheet,
        'pi_review_counts': batch['statusCounts'], 'editor_sync': editor_sync}))
    temporary.replace(status)
    print(timestamp, 'PASS database export:', counts[0], 'people,', counts[1], 'papers', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'FAIL database export:', type(error).__name__, flush=True)
        raise SystemExit(1)
