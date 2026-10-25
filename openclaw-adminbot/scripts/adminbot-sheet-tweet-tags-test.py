#!/usr/bin/env python3
"""Synthetic tweet-credit regression; no database credentials, network or Google writes."""
import importlib.util
import json
import sqlite3
from pathlib import Path


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


exporter = load('exporter', 'adminbot-sheet-export.py')
refresh = load('refresh', 'adminbot-sheet-refresh.py')
properties = {'PaperList': {'sheetId': 2, 'gridProperties': {'rowCount': 20, 'columnCount': 50}}}

# Copy text follows author identity/order, not alphabetical roster order or guessed usernames.
tweet_members = {
    'ada': {'id': 'ada', 'name': 'Ada Example', 'twitter_url': 'https://x.com/ada_example'},
    'bea': {'id': 'bea', 'name': 'Bea Example', 'twitter_url': '@bea_example'},
    'sam-1': {'id': 'sam-1', 'name': 'Sam Example', 'twitter_url': '@sam_one'},
    'sam-2': {'id': 'sam-2', 'name': 'Sam Example', 'twitter_url': '@sam_two'},
}
tweet_paper = {'id': 'tweet-paper', 'authors': ['Bea Example', 'Ada Example', 'External Example', 'Sam Example'],
    'author_links': [{'name': 'Bea Example', 'member_id': 'bea', 'twitter': '@stale_bea'},
                     {'name': 'External Example', 'twitter': 'https://twitter.com/external_test'}]}
tweet_links = {'arXiv': 'https://arxiv.org/abs/1234.56789',
    'GitHub': 'https://github.com/example/research', 'Submission': 'https://openreview.net/forum?id=example',
    'Overleaf share': 'https://www.overleaf.com/123secret#capability'}
copy = exporter.tweet_tags(tweet_paper, tweet_members, tweet_links)
assert copy == ('Paper Link: https://arxiv.org/abs/1234.56789\n\n'
    'GitHub Link: https://github.com/example/research\n\n'
    'Authors: @bea_example @ada_example @external_test Sam Example'), copy
assert 'stale_bea' not in copy and 'Affiliations' not in copy and 'secret' not in copy
assert exporter.tweet_tags({'authors': ['Ada Example'], 'author_links': [
    {'name': 'Ada Example', 'member_id': 'deleted-member'}]}, tweet_members, {}) == 'Authors: Ada Example'
assert exporter.tweet_tags({'author_links': [{'name': 'External Example', 'twitter': '@external_test'}]}, {}, {}) == (
    'Authors: @external_test')
assert exporter.tweet_tags({'authors': 'Ada Example; Unknown Example'}, tweet_members, {}) == (
    'Authors: @ada_example Unknown Example')
assert exporter.tweet_tags({}, tweet_members, {}) == ''
assert exporter.tweet_tags({'authors': ['private@example.org']}, {}, {}) == 'Authors: [author name missing]'
assert exporter.tweet_tags({'authors': ['Ada Example'], 'author_links': [
    {'name': 'Ada Example', 'member_id': 'ada'}, {'name': 'Ada Example', 'twitter': '@another_ada'}]},
    tweet_members, {}) == 'Authors: Ada Example'
for value in ['https://x.com/home', 'https://x.com/intent', 'https://x.com/i',
              'https://x.com/person/status/123', 'https://x.com/intent/tweet?text=hello',
              'https://x.com/person?token=private', 'https://x.com/person#private',
              'person@example.org', 'https://evil.example/person', '@handle_too_long_123', None]:
    assert exporter.x_handle(value) == '', value
for value in ['@ada_example', 'ada_example', 'https://x.com/ada_example/',
              'https://twitter.com/ada_example', 'twitter.com/#!/ada_example']:
    assert exporter.x_handle(value) == '@ada_example', value
assert exporter.tweet_tags({}, {}, {'arXiv': 'https://example.test/?token=private',
    'Submission': 'https://www.overleaf.com/read/secret#capability', 'GitHub': 'https://evil.example/repo'}) == ''
assert exporter.tweet_tags({}, {}, {'Submission': 'https://openreview.net/forum?id=example'}) == (
    'Paper Link: https://openreview.net/forum?id=example')
affiliations = exporter.TWEET_AFFILIATIONS
try:
    exporter.TWEET_AFFILIATIONS = {'ada example': ('@ExampleLab', '@ExampleInstitute')}
    assert exporter.tweet_tags({'authors': ['Ada Example']}, tweet_members, {}).endswith(
        'Affiliations: @ExampleLab @ExampleInstitute')
    assert 'Affiliations' not in exporter.tweet_tags({'authors': ['Bea Example']}, tweet_members, {})
finally:
    exporter.TWEET_AFFILIATIONS = affiliations
# The full snapshot re-derives the cell after a roster change and never changes the database.
tweet_connection = sqlite3.connect(':memory:')
for table in ('adminbot_lab_members', 'adminbot_papers'):
    tweet_connection.execute(f'CREATE TABLE {table}(id TEXT, payload_json TEXT)')
tweet_connection.execute('INSERT INTO adminbot_lab_members VALUES (?,?)', ('ada', json.dumps(tweet_members['ada'])))
tweet_connection.execute('INSERT INTO adminbot_papers VALUES (?,?)', ('tweet-paper', json.dumps(tweet_paper)))
tweet_connection.commit()
changes = tweet_connection.total_changes
def copy_from_snapshot():
    values = exporter.snapshot(tweet_connection, '2026-10-25T00:00:00Z', full_people=True)['data'][1]['values']
    columns = values[0]
    return next(row[columns.index('tweet tags to copy')] for row in values[1:]
                if row[columns.index(exporter.PAPER_ID)] == 'tweet-paper')
assert '@ada_example' in copy_from_snapshot()
assert tweet_connection.total_changes == changes
tweet_connection.execute('UPDATE adminbot_lab_members SET payload_json=? WHERE id=?',
          (json.dumps(dict(tweet_members['ada'], twitter_url='@ada_updated')), 'ada'))
tweet_connection.commit()
assert '@ada_updated' in copy_from_snapshot() and '@ada_example' not in copy_from_snapshot()
copy_index = exporter.PAPERS.index('tweet tags to copy')
copy_values = [list(exporter.PAPERS), [''] * len(exporter.PAPERS)]
copy_values[1][copy_index] = copy
copy_links = [[[] for _ in exporter.PAPERS] for _ in copy_values]
copy_styles = refresh.paper_style_requests(properties['PaperList'], copy_values, copy_links)
assert any(r.get('updateDimensionProperties', {}).get('range', {}).get('startIndex') == copy_index
           and r['updateDimensionProperties']['properties']['pixelSize'] == 420 for r in copy_styles)
assert any('not funding/support credits' in r.get('updateCells', {}).get('rows', [{}])[0].get('values', [{}])[0].get('note', '')
           for r in copy_styles)
print('PASS: copyable tweet links/credits, author order and identity, current roster handles, missing/ambiguous handles, affiliation scope, no secrets or posting')
