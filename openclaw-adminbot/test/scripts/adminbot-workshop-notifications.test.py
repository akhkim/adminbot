import copy
import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts'))
import adminbot_workshop_notifications as m
from adminbot_deadlines import AoEClock

URL = 'https://neurips.cc/Conferences/2026/CallForWorkshops'
TEXT = '<h1>Example workshop organizer requirements 2026</h1><p>Mandatory accept/reject notification date for workshop contributions: September 29, 2026, AoE.</p>'
QUOTE = 'Mandatory accept/reject notification date for workshop contributions: September 29, 2026, AoE.'


def answer():
    return {'entries': [dict(target=m.POLICY_ID, milestone='notification', label='Workshop notification cutoff',
        kind='date', date='2026-09-29', starts='', ends='', time='', timezone='AoE',
        source_url=URL, evidence=QUOTE, time_evidence=QUOTE)], 'issues': []}


def workshop(id='synthetic_workshop'):
    return dict(id=id, venue_type='workshop', venue_group='NeurIPS 2026 Workshops',
                notification_aoe='2026-09-29 23:59:59', deadline_aoe='2026-09-10 23:59:59')


class NotificationTests(unittest.TestCase):
    def refresh(self, rows, previous=None, day='2026-09-20', fetch=None, extract=None):
        return m.refresh_workshop_dates(rows, previous or {}, AoEClock.resolve(day),
            fetch_html=fetch or (lambda url: (url, TEXT)), extract=extract or (lambda *_: answer()))

    def test_migration_does_not_claim_a_shared_cutoff_is_a_decision(self):
        row = workshop()
        m.migrate_workshop_dates([row])
        self.assertEqual(row['notification_aoe'], '')
        self.assertEqual(row['notification_policy']['status'], 'unverified')
        self.assertEqual(row['notification_policy']['date'], '2026-09-29')
        self.assertEqual(row['notification_previous_aoe'], '2026-09-29 23:59:59')
        once = copy.deepcopy(row)
        m.migrate_workshop_dates([row])
        self.assertEqual(row, once)

    def test_policy_is_checked_once_for_many_workshops(self):
        calls = []
        rows = [workshop(str(i)) for i in range(12)]
        def fetch(url):
            calls.append(url)
            return url, TEXT
        self.refresh(rows, fetch=fetch)
        self.assertEqual(calls, [URL])
        self.assertEqual(sum('notification_policy_state' in row for row in rows), 1)
        self.assertTrue(all(row['notification_aoe'] == '' for row in rows))
        self.assertTrue(all(row['notification_policy']['status'] == 'source_backed' for row in rows))
        self.assertTrue(all(row['notification_policy']['kind'] == 'date' for row in rows))
        self.assertNotIn('planning_at', rows[0]['notification_policy'])

    def test_daily_cache_reuses_extraction(self):
        row = workshop()
        self.refresh([row])
        previous = {row['id']: copy.deepcopy(row)}
        self.refresh([row], previous, day='2026-09-21', extract=lambda *_: self.fail('unchanged source'))
        self.assertEqual(row['notification_policy']['status'], 'source_backed')
        self.assertNotEqual(row['notification_policy']['checked_at'], previous[row['id']]['notification_policy']['checked_at'])

    def test_failure_preserves_evidence_and_success_clock(self):
        row = workshop()
        self.refresh([row])
        old = copy.deepcopy(row)
        def fail(_): raise OSError('offline')
        self.refresh([row], {row['id']: old}, day='2026-09-21', fetch=fail)
        self.assertEqual(row['notification_policy']['date'], old['notification_policy']['date'])
        self.assertEqual(row['notification_policy']['checked_at'], old['notification_policy']['checked_at'])
        self.assertEqual(row['notification_policy']['status'], 'source_unavailable')
        self.assertEqual(row['notification_aoe'], '')

    def test_failed_first_check_keeps_unverified_legacy_day(self):
        row = workshop()
        self.refresh([row], extract=lambda *_: {'entries': [], 'issues': []})
        self.assertEqual(row['notification_policy']['date'], '2026-09-29')
        self.assertNotIn('evidence', row['notification_policy'])
        self.assertEqual(row['notification_aoe'], '')

    def test_missing_policy_target_does_not_advance_the_success_clock(self):
        row = workshop()
        self.refresh([row])
        previous = copy.deepcopy(row)
        invalid = answer()
        invalid['entries'][0]['target'] = 'schedule'
        self.refresh([row], {row['id']: previous}, day='2026-09-21',
            fetch=lambda url: (url, TEXT + '<p>Revised instructions.</p>'), extract=lambda *_: invalid)
        self.assertEqual(row['notification_policy']['checked_at'], previous['notification_policy']['checked_at'])
        self.assertEqual(row['notification_policy']['status'], 'extraction_unavailable')

    def test_conflicting_actual_date_is_not_replaced(self):
        row = workshop()
        row['schedule'] = [dict(milestone='notification', label='Decisions', kind='date', date='2026-10-01', evidence='Decision: October 1')]
        self.refresh([row])
        self.assertEqual(row['schedule'][0]['date'], '2026-10-01')
        self.assertIn('later than', row['notification_issues'][0])
        row['schedule'][0]['date'] = '2026-09-25'
        self.refresh([row], {row['id']: copy.deepcopy(row)})
        self.assertEqual(row['notification_issues'], [])

    def test_curated_legacy_submission_is_explicitly_unverified(self):
        row = dict(workshop(m.CURATED_WORKSHOP), venue_group='EMNLP 2026 Workshops')
        m.migrate_workshop_dates([row])
        self.assertEqual(row['deadline_source_status'], 'legacy_unverified')
        self.assertNotIn('notification_policy', row)
        self.assertEqual(row['notification_aoe'], '')

    def test_curated_workshop_source_supplies_submission_and_decision(self):
        url = 'https://sites.google.com/view/nlp4positiveimpact/call-for-papers-2026'
        text = '<h1>Synthetic workshop 2026 schedule</h1><p>ARR commitment deadline: August 9, 2026.</p><p>Notification of acceptance: August 23, 2026.</p>'
        row = dict(workshop(m.CURATED_WORKSHOP), venue_group='EMNLP 2026 Workshops', deadline_label='ARR commitment')
        primary = dict(answer()['entries'][0], target=row['id'], milestone='submission', label='ARR commitment',
            date='2026-08-09', source_url=url, evidence='ARR commitment deadline: August 9, 2026.', timezone='', time_evidence='')
        decision = dict(primary, target='schedule', milestone='notification', label='Notification of acceptance',
            date='2026-08-23', evidence='Notification of acceptance: August 23, 2026.')
        self.refresh([row], fetch=lambda _: (url, text), extract=lambda *_: {'entries': [primary, decision], 'issues': []})
        self.assertEqual(row['deadline_date'], '2026-08-09')
        self.assertEqual(row['notification_status'], 'source_backed')
        self.assertEqual(row['schedule'][0]['date'], '2026-08-23')
        self.assertEqual(row['notification_aoe'], '')

    def test_conflict_keeps_both_dates(self):
        row = workshop()
        m.migrate_workshop_dates([row])
        row['schedule'] = [dict(milestone='notification', date='2026-10-01', evidence='Decisions October 1')]
        self.assertEqual(len(m.notification_conflicts(row)), 1)
        self.assertEqual(row['schedule'][0]['date'], '2026-10-01')
        self.assertEqual(row['notification_policy']['date'], '2026-09-29')
        row['schedule'][0]['date'] = '2026-09-25'
        self.assertEqual(m.notification_conflicts(row), [])


if __name__ == '__main__': unittest.main()
