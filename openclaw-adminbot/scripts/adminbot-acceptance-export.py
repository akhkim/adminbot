#!/usr/bin/env python3
"""Peer-reviewed acceptances tab: one row per accepted paper, newest year first, each conference's rows together.

Rows come from the PaperList snapshot (`exporter.snapshot(...)['accepted']`), so Conference, Year and Track
are the same ones the Papers tab shows, OpenReview decisions included. Run on the database host by the
six-hourly refresh, which owns and rewrites this tab whole.
"""
import importlib.util
import re
from pathlib import Path

spec = importlib.util.spec_from_file_location('exporter', Path(__file__).with_name('adminbot-sheet-export.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

TITLE = 'Peer-Reviewed PaperAcceptance'
# The lab's own header, kept as it was typed: CV formulas and people read these names.
COLUMNS = ('year', 'paper title', 'conference', 'authors', 'paper_link')
COLUMN_WIDTHS = (70, 420, 260, 420, 300)
WIDTH = len(COLUMNS)
# Main papers first, then Findings, demos and workshops, so one conference reads top to bottom.
TRACK_ORDER = ('Main', 'Findings', 'Demo', 'Workshop', 'Industry', 'Tutorial', 'Journal', '')
# Conference values that are not one named conference: the accepted venue's own name stands instead.
UNNAMED = (*exporter.UNNAMED_CONFERENCES, 'Workshop', 'Journal')
# arXiv first: it is public and permanent; the Drive PDF stands in until the camera-ready is on arXiv.
LINK_ORDER = ('arXiv', 'PDF')


def venue_name(accepted):
    """'NeurIPS 2025 Workshop on X · Poster' -> 'NeurIPS Workshop on X': the venue, without year or presentation."""
    name = str(accepted or '').split(exporter.LINK_SEPARATOR)[0]
    return ' '.join(re.sub(r'\b20\d{2}\b', ' ', name).split())


def conference_cell(row):
    """'EMNLP', 'Findings of EMNLP', 'EMNLP System Demonstrations', or a workshop's / unlisted venue's own name."""
    named, track = row['Conference'], row['Track']
    if named in UNNAMED or track == 'Workshop':
        return venue_name(row['Accepted']) or named
    if track == 'Findings':
        return f'Findings of {named}'
    if track == 'Demo':
        return f'{named} System Demonstrations'
    return named


def accepted_entry(row):
    """One accepted PaperList row as this tab's fields."""
    links = {label.removesuffix(' 🔒'): url for label, url in row['Review link']}
    return {'id': row[exporter.PAPER_ID], 'year': str(row['Year'] or ''), 'title': ' '.join(str(row['Paper']).split()),
            'conference': row['Conference'], 'track': row['Track'], 'cell': conference_cell(row),
            'authors': exporter.cell(row['Authors']),
            'link': next((exporter.safe_link(links[k]) for k in LINK_ORDER if exporter.safe_link(links.get(k))), '')}


def sort_key(entry):
    """Newest year first (no year last); within a year by conference, then track, then title."""
    year = entry['year']
    group = entry['cell'] if entry['conference'] in UNNAMED else entry['conference']
    track = TRACK_ORDER.index(entry['track']) if entry['track'] in TRACK_ORDER else len(TRACK_ORDER)
    return (not year.isdigit(), -int(year) if year.isdigit() else 0, group.casefold(), track,
            entry['title'].casefold(), entry['id'])


def group_of(entry):
    return entry['year'], (entry['cell'] if entry['conference'] in UNNAMED else entry['conference']).casefold()


def acceptance_sheet(accepted):
    """{'values': header + one row per paper, 'firsts': rows that start a year+conference, 'links', 'counts'}.

    `accepted` is the snapshot's 'accepted' list: the PaperList rows of accepted papers, as paper_row built them.
    """
    entries = sorted((accepted_entry(row) for row in accepted), key=sort_key)
    values, firsts, links, previous = [list(COLUMNS)], [], {}, None
    for entry in entries:
        r = len(values)
        values.append([entry['year'], entry['title'], entry['cell'], entry['authors'], entry['link']])
        if entry['link']:
            links[(r, COLUMNS.index('paper_link'))] = entry['link']
        if group_of(entry) != previous:
            firsts.append(r)
            previous = group_of(entry)
    if any(len(str(v)) > 50000 for row in values for v in row):
        raise ValueError('Oversized acceptance cell')
    years = sorted({e['year'] for e in entries if e['year'].isdigit()}, reverse=True)
    return {'values': values, 'firsts': firsts, 'links': links,
            'counts': {'papers': len(entries), 'latest_year': years[0] if years else '',
                       'without_link': sum(1 for e in entries if not e['link'])}}


def adoptable(values):
    """Whether AdminBot may take over an unprotected tab: the header or nothing, never rows a person typed."""
    header = [str(v).strip().lower() for v in (values[0] if values else [])]
    blank_header = not any(header)
    return (blank_header or header[:WIDTH] == list(COLUMNS)) and not any(
        str(v).strip() for row in values[1:] for v in row)


def rgb(r, g, b):
    return {'red': r, 'green': g, 'blue': b}


INK, LINK, NAVY = rgb(.15, .19, .24), rgb(.12, .34, .67), rgb(.18, .29, .40)


def sheet_requests(sheet_id, grid, sheet):
    """One atomic batch: wipe the tab, write every cell with its format, then sizes. Styled like the letters tab."""
    values, firsts, links = sheet['values'], set(sheet['firsts']), sheet['links']
    whole = {'sheetId': sheet_id}
    requests = [
        {'unmergeCells': {'range': whole}},
        {'repeatCell': {'range': whole, 'cell': {}, 'fields': 'userEnteredValue,userEnteredFormat,dataValidation,note'}},
        {'updateSheetProperties': {'properties': {'sheetId': sheet_id, 'gridProperties': {
            'rowCount': max(grid.get('rowCount', 0), len(values) + 20), 'columnCount': max(grid.get('columnCount', 0), WIDTH),
            'frozenRowCount': 1, 'frozenColumnCount': 0, 'hideGridlines': True}},
            'fields': 'gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,'
                      'gridProperties.frozenColumnCount,gridProperties.hideGridlines'}},
    ]
    rows = []
    for r, row in enumerate(values):
        cells = []
        for c, value in enumerate(row):
            text = {'fontFamily': 'Arial', 'fontSize': 10, 'foregroundColor': INK, 'bold': False}
            fmt = {'verticalAlignment': 'TOP', 'wrapStrategy': 'WRAP', 'textFormat': text}
            # stringValue, never a formula: a title starting with '=' stays text.
            cell = {'userEnteredValue': {'stringValue': str(value)}, 'userEnteredFormat': fmt}
            if r == 0:
                text.update(bold=True, fontSize=11, foregroundColor=rgb(1, 1, 1))
                fmt.update(backgroundColor=NAVY, verticalAlignment='MIDDLE')
            else:
                if COLUMNS[c] in ('year', 'paper title'):
                    text['bold'] = True
                if COLUMNS[c] == 'paper_link':
                    fmt['wrapStrategy'] = 'CLIP'
                if (r, c) in links:
                    text.update(underline=True, foregroundColor=LINK, link={'uri': links[(r, c)]})
                if r in firsts and r > 1:
                    fmt['borders'] = {'top': {'style': 'SOLID', 'colorStyle': {'rgbColor': NAVY}}}
            cells.append(cell)
        rows.append({'values': cells})
    requests.append({'updateCells': {'range': {'sheetId': sheet_id, 'startRowIndex': 0, 'endRowIndex': len(values),
        'startColumnIndex': 0, 'endColumnIndex': WIDTH}, 'rows': rows,
        'fields': 'userEnteredValue,userEnteredFormat,dataValidation,note'}})
    requests.append({'updateDimensionProperties': {'range': {'sheetId': sheet_id, 'dimension': 'ROWS',
        'startIndex': 0, 'endIndex': 1}, 'properties': {'pixelSize': 32}, 'fields': 'pixelSize'}})
    requests.append({'updateDimensionProperties': {'range': {'sheetId': sheet_id, 'dimension': 'ROWS',
        'startIndex': 1, 'endIndex': max(len(values), 2)}, 'properties': {'pixelSize': 42}, 'fields': 'pixelSize'}})
    for c, width in enumerate(COLUMN_WIDTHS):
        requests.append({'updateDimensionProperties': {'range': {'sheetId': sheet_id, 'dimension': 'COLUMNS',
            'startIndex': c, 'endIndex': c + 1}, 'properties': {'pixelSize': width}, 'fields': 'pixelSize'}})
    return requests
