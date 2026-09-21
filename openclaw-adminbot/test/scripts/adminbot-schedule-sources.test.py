"""Offline schedule regression cases; no production collection or model calls."""
import copy
import importlib.util
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts'))
import adminbot_schedule_sources as m
from adminbot_deadlines import AoEClock

URL = 'https://conference.example/cfp'
SCOPE = 'Example 2035'
TEXT = '''<h1>Example 2035 official schedule</h1><table>
<tr><th>Stage</th><th>Date</th></tr>
<tr><td>Paper submission</td><td>August 3, 2035</td></tr>
<tr><td>Author response</td><td>September 14-24, 2035</td></tr></table>
<p>All deadlines are 11:59 PM UTC-12 (Anywhere on Earth).</p>'''
FOOTNOTE = '''<p>The initial author response is due on September 19, 2035.
Reviewer discussion runs September 20-24, 2035. A third phase is described in emailed instructions.</p>'''


def entry(label='Initial author response', milestone='author_response', date='2035-09-19', **kw):
    row = dict(target='schedule', milestone=milestone, label=label, kind='deadline', date=date,
               starts='', ends='', time='23:59:00', timezone='AoE', source_url=URL,
               evidence='The initial author response is due on September 19, 2035.',
               time_evidence='All deadlines are 11:59 PM UTC-12 (Anywhere on Earth).')
    return dict(row, **kw)


def result():
    return {'entries': [entry(), entry('Reviewer discussion', 'discussion', '', kind='period',
              starts='2035-09-20', ends='2035-09-24',
              evidence='Reviewer discussion runs September 20-24, 2035.'),
              entry('Paper submission', 'submission', '2035-08-03', target='example_paper',
                    evidence='Paper submission | August 3, 2035')],
            'issues': ['Third-phase dates are only described in emailed instructions.']}


def item():
    return dict(id='example_paper', venue_group=SCOPE, track='main', deadline_label='Paper submission',
                deadline_aoe='2035-08-03 23:59:00', schedule=[])


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.original_sources = m.SOURCE_URLS
        m.SOURCE_URLS = {SCOPE: [URL]}
        self.calls = []

    def tearDown(self):
        m.SOURCE_URLS = self.original_sources

    def refresh(self, old=None, html=TEXT + FOOTNOTE, day='2035-09-17', answer=None, force=False):
        row = item()
        if old:
            row.update(copy.deepcopy(old))
        def extract(context, documents):
            self.calls.append(documents)
            return copy.deepcopy(answer if answer is not None else result())
        m.refresh_schedules([row], {row['id']: old} if old else {}, AoEClock.resolve(day), force,
                            fetch_html=lambda url: (url, html), extract=extract)
        return row

    def test_split_response_and_discussion_with_unpublished_phase(self):
        row = self.refresh()
        self.assertEqual([x['milestone'] for x in row['schedule']], ['author_response', 'discussion'])
        self.assertEqual(row['schedule'][0]['date'], '2035-09-19 23:59:00')
        self.assertEqual(row['schedule'][1]['ends'], '2035-09-24')
        self.assertEqual(row['schedule_status'], 'needs_review')
        self.assertEqual(row['schedule'][0]['planning_at'], '2035-09-20T11:59:00Z')
        self.assertIn('Third-phase', row['schedule_issues'][0])

    def test_footnote_change_triggers_extraction_when_table_is_unchanged(self):
        broad = entry('Author response', 'rebuttal', '', kind='period', starts='2035-09-14', ends='2035-09-24',
                      evidence='Author response | September 14-24, 2035')
        old = self.refresh(html=TEXT, answer={'entries': [broad], 'issues': []})
        updated = self.refresh(old, day='2035-09-18')
        self.assertEqual(len(self.calls), 2)
        self.assertNotEqual(updated['schedule_observation']['hash'], old['schedule_observation']['hash'])
        self.assertEqual(updated['schedule'][0]['date'][:10], '2035-09-19')
        self.assertTrue(any('Previously listed' in x for x in updated['schedule_issues']))
        cached = self.refresh(updated, day='2035-09-19')
        self.assertTrue(any('Previously listed' in x for x in cached['schedule_issues']))
        self.assertEqual(len(self.calls), 2)

    def test_unchanged_text_reuses_inference_and_keeps_extraction_clock(self):
        old = self.refresh()
        new = self.refresh(old, day='2035-09-18')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(new['schedule_extracted_at'], old['schedule_extracted_at'])
        self.assertNotEqual(new['schedule_checked_at'], old['schedule_checked_at'])
        self.assertEqual(new['schedule'], old['schedule'])

    def test_same_day_skips_fetch_and_preserves_observation(self):
        old = self.refresh()
        row = item()
        m.refresh_schedules([row], {row['id']: old}, AoEClock.resolve('2035-09-17'),
                            fetch_html=lambda url: self.fail('not due'))
        self.assertEqual(row['schedule_observation'], old['schedule_observation'])
        self.assertEqual(row['schedule_issues'], old['schedule_issues'])

    def test_failed_fetch_keeps_schedule_and_success_clock(self):
        old = self.refresh()
        row = copy.deepcopy(old)
        def unavailable(url):
            raise OSError('offline')
        m.refresh_schedules([row], {row['id']: old}, AoEClock.resolve('2035-09-18'), fetch_html=unavailable)
        self.assertEqual(row['schedule'], old['schedule'])
        self.assertEqual(row['schedule_checked_at'], old['schedule_checked_at'])
        self.assertEqual(row['schedule_status'], 'source_unavailable')

    def test_invalid_extraction_is_atomic_and_retried(self):
        old = self.refresh()
        invalid = result()
        invalid['entries'][0]['date'] = '2035-09-25'
        row = self.refresh(old, html=TEXT + FOOTNOTE + '<p>New notice</p>', day='2035-09-18', answer=invalid)
        self.assertEqual(row['schedule'], old['schedule'])
        self.assertEqual(row['schedule_checked_at'], old['schedule_checked_at'])
        self.assertEqual(row['schedule_status'], 'extraction_unavailable')
        self.refresh(row, html=TEXT + FOOTNOTE + '<p>New notice</p>', day='2035-09-18')
        self.assertEqual(len(self.calls), 2)
        self.refresh(row, html=TEXT + FOOTNOTE + '<p>New notice</p>', day=row['schedule_retry_at'])
        self.assertEqual(len(self.calls), 3)

    def test_wrong_evidence_and_conflicting_dates_rejected(self):
        for change in ['missing_quote', 'wrong_source', 'invented_time', 'conflict']:
            with self.subTest(change=change):
                value = result()
                if change == 'missing_quote': value['entries'][0]['evidence'] = 'invented evidence'
                elif change == 'wrong_source': value['entries'][0]['source_url'] = 'https://other.example'
                elif change == 'invented_time': value['entries'][0]['time'] = '22:59:00'
                else:
                    value['entries'].append(entry(date='2035-09-24', evidence='Author response | September 14-24, 2035'))
                row = self.refresh(answer=value)
                self.assertEqual(row['schedule_status'], 'extraction_unavailable')
                self.assertEqual(row['schedule'], [])

    def test_utc_evidence_rejects_gmt_and_utc_offsets(self):
        for zone in ['GMT+2', 'GMT-5', 'GMT − 2', 'UTC+2', 'UTC - 5']:
            with self.subTest(zone=zone):
                quote = f'All deadlines are 23:59 {zone}.'
                value = {'entries': [entry(timezone='UTC', time_evidence=quote)], 'issues': []}
                with self.assertRaises(m.SourceUnavailable):
                    m.validate_result(value, {URL: m.source_text(TEXT + FOOTNOTE + quote)},
                                      {'year': 2035, 'targets': [{'id': 'example_paper'}]})

    def test_plain_gmt_and_utc_remain_supported(self):
        for zone in ['GMT', 'UTC']:
            with self.subTest(zone=zone):
                quote = f'All deadlines are 23:59 {zone}.'
                value = {'entries': [entry(timezone='UTC', time_evidence=quote)], 'issues': []}
                entries, _ = m.validate_result(value, {URL: m.source_text(TEXT + FOOTNOTE + quote)},
                                               {'year': 2035, 'targets': [{'id': 'example_paper'}]})
                self.assertEqual(entries[0]['deadline_planning_at'], '2035-09-19T23:59:00Z')

    def test_date_only_uses_earliest_timezone_and_no_aoe_claim(self):
        value = result()
        value['entries'][0].update(time='', timezone='', time_evidence='')
        row = self.refresh(answer=value)
        stage = row['schedule'][0]
        self.assertEqual(stage['kind'], 'date')
        self.assertEqual(stage['date'], '2035-09-19')
        self.assertEqual(stage['planning_at'], '2035-09-18T10:00:00Z')

    def test_separately_observed_primary_deadline_is_not_overwritten(self):
        old = item()
        old.update(_source_observed=True, deadline_aoe='2035-08-04 23:59:00')
        row = self.refresh(old)
        self.assertEqual(row['deadline_aoe'], old['deadline_aoe'])
        self.assertTrue(any('disagrees' in issue for issue in row['schedule_issues']))

    def test_bounded_text_is_not_silently_truncated(self):
        row = self.refresh(html='<p>' + 'long schedule ' * 10000 + '</p>')
        self.assertEqual(row['schedule_status'], 'source_unavailable')
        self.assertEqual(self.calls, [])

    def test_script_changes_do_not_trigger_model_calls(self):
        old = self.refresh(html=TEXT + FOOTNOTE + '<script>let build="old";</script>')
        new = self.refresh(old, day='2035-09-18', html=TEXT + FOOTNOTE + '<script>let build="new";</script>')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(new['schedule'], old['schedule'])

    def test_cold_collection_does_not_need_a_baked_in_deadline(self):
        row = item()
        row['deadline_aoe'] = ''
        m.refresh_schedules([row], {}, AoEClock.resolve('2035-09-17'),
                            fetch_html=lambda url: (url, TEXT + FOOTNOTE), extract=lambda *_: result())
        self.assertEqual(row['deadline_aoe'], '2035-08-03 23:59:00')
        self.assertEqual(row['deadline_source_kind'], 'official_schedule')

    def test_wrong_edition_and_primary_target_are_rejected(self):
        for field, value in [('date', '2036-09-19'), ('target', 'another_track')]:
            answer = result()
            answer['entries'][0][field] = value
            self.assertEqual(self.refresh(answer=answer)['schedule_status'], 'extraction_unavailable')

    def test_missing_model_configuration_fails_without_network(self):
        from unittest.mock import patch
        with patch.dict(m.os.environ, {}, clear=True):
            with self.assertRaises(m.SourceUnavailable):
                m.extract_local({}, {})
        with patch.dict(m.os.environ, {'ADMINBOT_LOCAL_BASE_URL': 'https://remote.example/v1',
                                     'ADMINBOT_LOCAL_MODEL': 'example', 'VLLM_API_KEY': 'synthetic'}, clear=True):
            with self.assertRaises(m.SourceUnavailable):
                m.extract_local({}, {})

    def test_offline_output_does_not_recreate_curated_schedule(self):
        spec = importlib.util.spec_from_file_location('collector', pathlib.Path(m.__file__).with_name('adminbot-deadline-collect.py'))
        collector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(collector)
        self.assertFalse(hasattr(collector, 'SCHEDULES'))
        self.assertTrue(all(not row['deadline_aoe'] and not row['notification_aoe'] for row in collector.CONFERENCES))


if __name__ == '__main__':
    unittest.main()
