import copy
import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts'))
import adminbot_workshop_notifications as m


def workshop(id='synthetic_workshop'):
    return dict(id=id, venue_type='workshop', venue_group='NeurIPS 2026 Workshops',
                notification_aoe='2026-09-29 23:59:59', deadline_aoe='2026-09-10 23:59:59')


class NotificationTests(unittest.TestCase):
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

    def test_curated_legacy_submission_is_explicitly_unverified(self):
        row = dict(workshop(m.CURATED_WORKSHOP), venue_group='EMNLP 2026 Workshops')
        m.migrate_workshop_dates([row])
        self.assertEqual(row['deadline_source_status'], 'legacy_unverified')
        self.assertNotIn('notification_policy', row)
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
