"""Workshop decision dates and shared organizer notification requirements."""

CURATED_WORKSHOP = 'emnlp2026_ws_nlp4pi'


def migrate_workshop_dates(items):
    """Keep legacy values inspectable without presenting shared cutoffs as decisions."""
    for item in items:
        if item.get('venue_type') != 'workshop':
            continue
        stamp = item.get('notification_aoe', '')
        if stamp and item.get('notification_status') != 'source_backed':
            item.setdefault('notification_previous_aoe', stamp)
            item['notification_status'] = 'unverified'
            item['notification_aoe'] = ''
            if item.get('venue_group') == 'NeurIPS 2026 Workshops':
                item.setdefault('notification_policy', {
                    'milestone': 'notification_by', 'label': 'Workshops must notify authors by',
                    'kind': 'date', 'date': stamp[:10], 'status': 'unverified',
                })
        if (item.get('id') == CURATED_WORKSHOP and item.get('deadline_aoe')
                and not item.get('deadline_source_evidence')):
            item['deadline_source_status'] = 'legacy_unverified'
        for issue in notification_conflicts(item):
            if issue not in item.setdefault('notification_issues', []):
                item['notification_issues'].append(issue)
    return items


def notification_conflicts(item):
    cutoff = item.get('notification_policy', {}).get('date', '')
    return ['Published decision date is later than the shared notification cutoff.'] if any(
        stage.get('milestone') == 'notification' and stage.get('evidence') and cutoff
        and stage.get('date', '')[:10] > cutoff[:10] for stage in item.get('schedule', [])
    ) else []
