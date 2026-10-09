#!/usr/bin/env python3
"""Operator-approved daily database export to exactly two protected sheet tabs."""
import argparse
import datetime
import importlib.util
import json
import os
import shlex
import sqlite3
import subprocess
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('exporter', Path(__file__).with_name('adminbot-sheet-export.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


def paper_style_requests(properties, values):
    sid = properties['sheetId']
    row_count = len(values)
    stage = exporter.PAPERS.index('current_step')
    link_start = exporter.PAPERS.index('draft_link')
    link_end = exporter.PAPERS.index('linkedin_post_link') + 1
    area = {'sheetId': sid, 'startRowIndex': 0, 'endRowIndex': row_count,
            'startColumnIndex': 0, 'endColumnIndex': len(exporter.PAPERS)}
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
        {'repeatCell': {'range': {**area, 'startRowIndex': 1, 'endColumnIndex': 1},
            'cell': {'userEnteredFormat': {'wrapStrategy': 'CLIP', 'textFormat': {
                'fontSize': 9, 'foregroundColor': {'red': .42, 'green': .47, 'blue': .53}}}},
            'fields': 'userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.foregroundColor'}},
        {'repeatCell': {'range': {**area, 'startRowIndex': 1, 'startColumnIndex': stage, 'endColumnIndex': stage + 1},
            'cell': {'userEnteredFormat': {'textFormat': {'bold': True}}},
            'fields': 'userEnteredFormat.textFormat.bold'}},
        {'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'ROWS', 'startIndex': 0, 'endIndex': 1},
            'properties': {'pixelSize': 36}, 'fields': 'pixelSize'}},
        # Long author lists remain in the cell; a bounded row height keeps the PI's overview scannable.
        {'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'ROWS', 'startIndex': 1, 'endIndex': row_count},
            'properties': {'pixelSize': 72}, 'fields': 'pixelSize'}},
        {'updateSheetProperties': {'properties': {'sheetId': sid, 'gridProperties': {'hideGridlines': True}},
            'fields': 'gridProperties.hideGridlines'}},
    ]
    widths = [({'id': 160, 'title': 460, 'authors': 400, 'blocker': 280, 'next_action': 280,
                'missing_recorded_artifacts': 320, 'invalid_recorded_artifacts': 320,
                'artifact_statuses': 320}).get(name, 180) for name in exporter.PAPERS]
    for index, width in enumerate(widths):
        requests.append({'updateDimensionProperties': {'range': {'sheetId': sid, 'dimension': 'COLUMNS',
            'startIndex': index, 'endIndex': index + 1}, 'properties': {
                'pixelSize': width,
                'hiddenByUser': not any(str(row[index]).strip() for row in values[1:])},
            'fields': 'pixelSize,hiddenByUser'}})
    requests.extend([
        {'repeatCell': {'range': {**area, 'startRowIndex': 1, 'startColumnIndex': link_start, 'endColumnIndex': link_end},
            'cell': {'userEnteredFormat': {'wrapStrategy': 'CLIP', 'textFormat': {
                'underline': True, 'foregroundColor': {'red': .12, 'green': .34, 'blue': .67}}}},
            'fields': 'userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.underline,userEnteredFormat.textFormat.foregroundColor'}},
        {'updateCells': {'range': {**area, 'startRowIndex': 1, 'startColumnIndex': link_start, 'endColumnIndex': link_end},
            'rows': [{'values': [{'userEnteredFormat': {'textFormat': {
                'link': {'uri': value}}}} if value else {} for value in row[link_start:link_end]]} for row in values[1:]],
            'fields': 'userEnteredFormat.textFormat.link'}},
    ])
    return requests


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
        ids = [row[0] for row in values[1:]]
        if not all(ids) or len(ids) != len(set(ids)):
            raise ValueError('Missing or duplicate record IDs')
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
            {'repeatCell': {'range': {'sheetId': sid, 'startRowIndex': 1}, 'cell': {}, 'fields': 'userEnteredValue'}},
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
        stage = headers.index('current_step' if title == 'PaperList' else 'status')
        options = sorted({row[stage] for row in values[1:] if row[stage]})
        if options:
            columns[stage].update(columnType='DROPDOWN', dataValidationRule={'condition': {
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
        views = [(title + ' sort and filter', None)]
        if title == 'PaperList':
            views += [('By stage', 'current_step'), ('By venue', 'venue'), ('By review category', 'review_category')]
        else:
            views += [('By joined date', 'join_date'), ('Review inactive members', 'membership_review'), ('By membership type', 'member_type'), ('By Slack active channel', 'slack_active')]
        for view_title, sort_column in views:
            view = next((v for v in p.get('filterViews', []) if v['title'] == view_title), None)
            if view and tables and view.get('tableId') != tables[0]['tableId']:
                # Sheets does not convert a range-backed view into a table view in place.
                requests.append({'deleteFilterView': {'filterId': view['filterViewId']}})
                view = None
            specification = {'tableId': tables[0]['tableId']} if tables else {'range': table_range}
            fields = 'range,namedRangeId,tableId' if tables else 'range'
            if sort_column:
                specification['sortSpecs'] = [{'dimensionIndex': headers.index(column), 'sortOrder': 'ASCENDING'}
                                              for column in [sort_column, 'title' if title == 'PaperList' else 'name']]
                fields += ',sortSpecs'
                if sort_column == 'join_date':
                    specification['sortSpecs'][0]['sortOrder'] = 'DESCENDING'
                if view_title == 'Review inactive members':
                    specification['criteria'] = {str(headers.index('membership_review')): {'condition': {'type': 'TEXT_EQ', 'values': [{'userEnteredValue': 'Review inactive'}]}}}
                    fields += ',criteria'
            if view:
                requests.append({'updateFilterView': {'filter': {**specification, 'filterViewId': view['filterViewId']},
                    'fields': fields}})
            else:
                requests.append({'addFilterView': {'filter': {**specification, 'title': view_title}}})
        if title == 'PaperList':
            requests.extend(paper_style_requests(p, values))
    return requests


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

    def gog(arguments):
        result = subprocess.run([args.gog, '--no-input', '--json', *arguments], env=env,
                                capture_output=True, text=True, timeout=60)
        if result.returncode:
            # CLI stderr may contain credentials or fetched content; never log it.
            raise RuntimeError('Google CLI exit ' + str(result.returncode))
        return json.loads(result.stdout)

    spreadsheet = config['spreadsheet_id']
    ownership = gog(['--readonly', 'api', 'call', 'drive', 'v3', 'drive.files.get',
        '--params', json.dumps({'fileId': spreadsheet, 'fields': 'owners(emailAddress)'})])
    allowed_editors = {writer} | {owner['emailAddress'].lower() for owner in ownership['owners']}
    metadata = gog(['--readonly', 'api', 'call', 'sheets', 'v4', 'sheets.spreadsheets.get',
        '--params', json.dumps({'spreadsheetId': spreadsheet, 'fields': 'sheets(properties,protectedRanges,filterViews,bandedRanges,tables)'})])
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
                             'bandedRanges': sheet.get('bandedRanges', []), 'tables': sheet.get('tables', [])}
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with sqlite3.connect(Path(args.database).resolve().as_uri() + '?mode=ro', uri=True, timeout=15) as connection:
        connection.execute('PRAGMA query_only=ON')
        batch = exporter.snapshot(connection, timestamp, full_people=True)
    requests = refresh_requests(batch, properties)
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as body:
        json.dump({'requests': requests}, body)
        body.flush()
        gog(['api', 'call', 'sheets', 'v4', 'sheets.spreadsheets.batchUpdate', '--params',
             json.dumps({'spreadsheetId': spreadsheet}), '--body', '@' + body.name, '--allow-write', '--force'])
    counts = []
    for item in batch['data']:
        title = item['range'].split("'")[1]
        values = item['values']
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
    status = Path(args.status)
    temporary = status.with_suffix('.tmp')
    temporary.write_text(json.dumps({'last_success_utc': timestamp,
        'member_rows': counts[0], 'paper_rows': counts[1], 'spreadsheet_id': spreadsheet}))
    temporary.replace(status)
    print(timestamp, 'PASS database export:', counts[0], 'people,', counts[1], 'papers', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'FAIL database export:', type(error).__name__, flush=True)
        raise SystemExit(1)
