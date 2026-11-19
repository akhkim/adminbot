#!/usr/bin/env python3
"""Recommendation-letter tab for the PI: one row per letter, grouped by student, earliest deadline first. Run on the database host."""
import datetime
import importlib.util
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

spec = importlib.util.spec_from_file_location('exporter', Path(__file__).with_name('adminbot-sheet-export.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

TITLE = 'Rec letters'
COLUMNS = ('Student', 'Letter due', 'Left', 'School · program', 'Letter status', 'Check',
           'What the program looks for', 'Program', 'CV', 'Drive', 'What to highlight')
COLUMN_WIDTHS = (170, 170, 90, 230, 120, 220, 360, 80, 60, 60, 380)
WIDTH = len(COLUMNS)
# MATS references go through MATS's own form, not a letter; the PI's sheet tracks them elsewhere.
EXCLUDED_PROGRAMS = re.compile(r'\bMATS\b', re.I)
ZONES = {'aoe': 'Etc/GMT+12', 'cet': 'Europe/Berlin', 'cest': 'Europe/Berlin', 'et': 'America/New_York',
         'pt': 'America/Los_Angeles', 'utc': 'UTC', 'gmt': 'UTC'}
DONE = re.compile(r'submitted|sent|done|complete', re.I)
NOT_ASKED = re.compile(r'not (yet )?requested', re.I)
# Student -> student whose block they sit directly below; everyone else runs by next letter due.
# Lower-cased student names: {follower: leader} keeps a follower's rows right below the leader's. People's
# names stay out of this public repo; the refresh reads them from the private destination config.
FOLLOWS = {}


def zone(name):
    """The deadline's time zone and a note when it had to be assumed."""
    key = (name or '').strip()
    if not key:
        return ZoneInfo('Etc/GMT+12'), 'Time zone not set: AoE assumed'
    try:
        return ZoneInfo(ZONES.get(key.lower(), key)), ''
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo('Etc/GMT+12'), f'Unknown time zone "{key}": AoE assumed'


def letter_deadline(school, now=None):
    """(moment, local label, notes). The application date stands in when no letter date is recorded."""
    notes, fallback = [], False
    day = (school.get('letter_deadline') or '').strip()
    clock = (school.get('letter_deadline_time') or '').strip()
    if not day:
        day = (school.get('application_deadline') or '').strip()
        clock = (school.get('application_deadline_time') or '').strip()
        if day:
            notes.append('No letter date: application date used')
            fallback = True
    if not day:
        return None, 'Not set', ['No deadline recorded: ask the student']
    tz, note = zone(school.get('deadline_timezone'))
    notes += [note] if note else []
    try:
        moment = datetime.datetime.fromisoformat(f'{day[:10]}T{clock or "23:59"}').replace(tzinfo=tz)
    except ValueError:
        return None, day, notes + ['Deadline unreadable: ask the student']
    if fallback and now and moment < now:
        return None, None, []  # Application closed and no letter date: nothing left to schedule.
    name = 'AoE' if tz.key == 'Etc/GMT+12' else (school.get('deadline_timezone') or '').strip()
    return moment, moment.strftime('%a %-d %b, %H:%M ') + name, notes


def countdown(moment, done, now):
    if done:
        return '✅ Done'
    if not moment:
        return '❔ Ask for date'
    hours = (moment - now).total_seconds() / 3600
    days = int(hours // 24)
    if hours < 0:
        return f'⛔ {-days - 1 or 1} d overdue' if hours <= -24 else '⛔ Overdue'
    if hours < 24:
        return f'🔴 {int(hours)} h left'
    marker = '🔴' if days <= 2 else '🟠' if days <= 7 else '🟡' if days <= 14 else '🟢'
    return f'{marker} {days} d left'


def letter_requests(connection):
    rows = connection.execute('SELECT payload_json FROM adminbot_logistics_requests ORDER BY id').fetchall()
    found = []
    for (payload,) in rows:
        record = json.loads(payload)
        if record.get('kind') == 'recommendation_letters' and record.get('status') == 'submitted':
            found.append(record)
    return found


def student_block(record, now):
    """Schools as table rows, plus the facts and links the PI needs for this student's letters."""
    schools = []
    for school in record.get('schools') or []:
        if EXCLUDED_PROGRAMS.search(' '.join(str(school.get(k) or '') for k in ('school', 'program'))):
            continue
        letter = (school.get('letter_status') or '').strip()
        done = bool(DONE.search(letter)) and not re.search(r'\bnot\b', letter, re.I)
        moment, label, notes = letter_deadline(school, now)
        if label is None:
            continue
        applied = (school.get('application_deadline') or '').strip()[:10]
        if applied and (school.get('letter_deadline') or '').strip()[:10] not in ('', applied):
            notes.insert(0, f'Application closes {applied}: confirm letter date')
        if not letter:
            notes.append('Letter status not set')
        elif NOT_ASKED.search(letter):
            notes.append('Portal has not asked yet')
        link = exporter.safe_link(school.get('program_link'))
        name = ' · '.join(x for x in (school.get('school'), school.get('program')) if x and str(x).strip())
        schools.append({'moment': moment, 'done': done, 'link': link, 'letter': letter, 'cells': [
            label, countdown(moment, done, now), name or 'School not named', letter or '—', '\n'.join(notes),
            (school.get('notes') or '').strip()]})
    if not schools:
        return None
    far = datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
    schools.sort(key=lambda s: (s['done'], s['moment'] or far))
    upcoming = [s for s in schools if not s['done']]
    return {'name': (record.get('member_name') or record.get('member_id') or 'Unknown student').strip(),
            'id': record.get('id', ''), 'schools': schools, 'next': upcoming[0]['moment'] if upcoming else None,
            'open': len(upcoming), 'cv': exporter.safe_link(record.get('cv_overleaf_url')),
            'drive': exporter.safe_link(record.get('drive_folder_url')),
            'facts': '\n'.join(f"• {(f.get('project') or '').strip()}: {(f.get('contribution') or '').strip()}"
                                for f in record.get('facts') or [] if f.get('project') or f.get('contribution'))}


def letter_sheet(connection, timestamp, follows=None):
    """{'values': header + one row per letter, 'firsts': rows that start a student, 'links', 'done', 'counts'}.

    Students by their next letter due (FOLLOWS places a student right below another); within a student, letters run by deadline with finished ones last.
    """
    now = exporter.parse_time(timestamp)
    blocks = [b for b in (student_block(r, now) for r in letter_requests(connection)) if b]
    far = datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
    blocks.sort(key=lambda b: (b['next'] or far, b['name'].lower()))
    for follower, leader in (FOLLOWS if follows is None else follows).items():
        names = [b['name'].lower() for b in blocks]
        if follower in names and leader in names:
            moved = blocks.pop(names.index(follower))
            blocks.insert([b['name'].lower() for b in blocks].index(leader) + 1, moved)
    open_ = [s for b in blocks for s in b['schools'] if not s['done']]
    week = sum(1 for s in open_ if s['moment'] and s['moment'] - now <= datetime.timedelta(days=7))
    values, firsts, links, done = [list(COLUMNS)], [], {}, []
    for block in blocks:
        for index, school in enumerate(block['schools']):
            r, first = len(values), index == 0
            values.append([block['name'], *school['cells'],
                           'Open' if school['link'] else '',
                           'Open' if block['cv'] else '⚠ none',
                           'Open' if block['drive'] else '⚠ none',
                           (block['facts'] or '⚠ No facts yet: ask the student') if first else ''])
            for column, url in (('Program', school['link']), ('CV', block['cv']), ('Drive', block['drive'])):
                if url:
                    links[(r, COLUMNS.index(column))] = url
            (firsts.append(r) if first else None)
            (done.append(r) if school['done'] else None)
    if any(len(str(v)) > 50000 for row in values for v in row):
        raise ValueError('Oversized letter cell')
    return {'values': values, 'firsts': firsts, 'links': links, 'done': done,
            'counts': {'students': len(blocks), 'open_letters': len(open_), 'due_7_days': week}}


def rgb(r, g, b):
    return {'red': r, 'green': g, 'blue': b}


INK, MUTED, LINK, NAVY = rgb(.15, .19, .24), rgb(.55, .58, .62), rgb(.12, .34, .67), rgb(.18, .29, .40)
COUNTDOWN_COLOURS = {'⛔': rgb(.96, .73, .73), '🔴': rgb(.99, .87, .87), '🟠': rgb(1, .92, .82),
                     '🟡': rgb(1, .97, .80), '🟢': rgb(.89, .96, .89)}
HEADER_NOTES = {
    'Letter status': 'As the student recorded it. "requested" means the portal asked for the letter, not that it was sent.',
}


def sheet_requests(sheet_id, grid, sheet):
    """One atomic batch: wipe the tab, write every cell with its format, then sizes. Styled like the Papers tab."""
    values, firsts, links, done = sheet['values'], set(sheet['firsts']), sheet['links'], set(sheet['done'])
    whole = {'sheetId': sheet_id}
    # Unmerge before freezing: Sheets refuses a frozen column that cuts through the old layout's merges.
    requests = [
        {'unmergeCells': {'range': whole}},
        {'repeatCell': {'range': whole, 'cell': {}, 'fields': 'userEnteredValue,userEnteredFormat,dataValidation,note'}},
        {'updateSheetProperties': {'properties': {'sheetId': sheet_id, 'gridProperties': {
            'rowCount': max(grid.get('rowCount', 0), len(values) + 20), 'columnCount': max(grid.get('columnCount', 0), WIDTH),
            'frozenRowCount': 1, 'frozenColumnCount': 1, 'hideGridlines': True}},
            'fields': 'gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,'
                      'gridProperties.frozenColumnCount,gridProperties.hideGridlines'}},
    ]
    rows = []
    for r, row in enumerate(values):
        cells = []
        for c, value in enumerate(row):
            text = {'fontFamily': 'Arial', 'fontSize': 10, 'foregroundColor': INK, 'bold': False}
            fmt = {'verticalAlignment': 'TOP', 'wrapStrategy': 'WRAP', 'textFormat': text}
            cell = {'userEnteredValue': {'stringValue': str(value)}, 'userEnteredFormat': fmt}
            if r == 0:
                text.update(bold=True, fontSize=11, foregroundColor=rgb(1, 1, 1))
                fmt.update(backgroundColor=NAVY, verticalAlignment='MIDDLE')
                if value in HEADER_NOTES:
                    cell['note'] = HEADER_NOTES[value]
            else:
                if c == 0:
                    text['bold'] = True
                if COLUMNS[c] == 'Left' and value[:1] in COUNTDOWN_COLOURS:
                    text['bold'] = True
                    fmt['backgroundColor'] = COUNTDOWN_COLOURS[value[:1]]
                if COLUMNS[c] == 'Check' or r in done and c > 0:
                    text['foregroundColor'] = MUTED
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
        'startIndex': 0, 'endIndex': 1}, 'properties': {'pixelSize': 36}, 'fields': 'pixelSize'}})
    # As on the Papers tab: long text stays in the cell, a bounded row height keeps the list scannable.
    requests.append({'updateDimensionProperties': {'range': {'sheetId': sheet_id, 'dimension': 'ROWS',
        'startIndex': 1, 'endIndex': max(len(values), 2)}, 'properties': {'pixelSize': 60}, 'fields': 'pixelSize'}})
    for c, width in enumerate(COLUMN_WIDTHS):
        requests.append({'updateDimensionProperties': {'range': {'sheetId': sheet_id, 'dimension': 'COLUMNS',
            'startIndex': c, 'endIndex': c + 1}, 'properties': {'pixelSize': width}, 'fields': 'pixelSize'}})
    if grid.get('columnCount', 0) > WIDTH:
        requests.append({'updateDimensionProperties': {'range': {'sheetId': sheet_id, 'dimension': 'COLUMNS',
            'startIndex': WIDTH, 'endIndex': grid['columnCount']}, 'properties': {'hiddenByUser': True},
            'fields': 'hiddenByUser'}})
    return requests
