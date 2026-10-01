"""Workshop decision dates and shared organizer notification requirements."""
import copy

from adminbot_schedule_sources import refresh_schedules, project_milestone, extract_local, SourceUnavailable

CURATED_WORKSHOP = 'emnlp2026_ws_nlp4pi'
POLICY_SCOPE = 'NeurIPS 2026 workshop contributions'
POLICY_ID = 'neurips2026_workshop_notification_by'


def notification_conflicts(item):
    cutoff = item.get('notification_policy', {}).get('date', '')
    return ['Published decision date is later than the shared notification cutoff.'] if any(
        stage.get('milestone') == 'notification' and stage.get('evidence') and cutoff
        and stage.get('date', '')[:10] > cutoff[:10] for stage in item.get('schedule', [])
    ) else []


def refresh_workshop_dates(items, previous_by_id, clock, force_refresh=False, *, fetch_html, extract=extract_local):
    for item in items:
        if item.get('venue_type') == 'workshop':
            previous = previous_by_id.get(item['id'], {})
            if not item.get('schedule') and previous.get('schedule'):
                item['schedule'] = copy.deepcopy(previous['schedule'])
            if previous.get('notification_status') == 'source_backed' and not item.get('notification_aoe'):
                item['notification_aoe'] = previous.get('notification_aoe', '')
            for key in ('notification_policy', 'notification_policy_state', 'notification_status',
                        'notification_previous_aoe', 'notification_issues'):
                if key in previous:
                    item[key] = copy.deepcopy(previous[key])
    curated = [item for item in items if item.get('id') == CURATED_WORKSHOP]
    for item in curated:
        item['_schedule_purpose'] = (
            'Read this workshop CFP. The primary target is ARR commitment through OpenReview. '
            'Do not use the direct-submission deadline or an alternative form closing date for that target. '
            'Keep alternative routes as separate stages with their conditions in issues. '
            'Include this workshop\'s own notification of acceptance as a notification milestone.'
        )
    refresh_schedules(curated, previous_by_id, clock, force_refresh, fetch_html=fetch_html, extract=extract)
    for item in curated:
        item.pop('_schedule_purpose', None)
        if any(stage.get('milestone') == 'notification' and stage.get('evidence')
               for stage in item.get('schedule', [])):
            item['notification_status'] = 'source_backed'

    members = [item for item in items if item.get('venue_group') == 'NeurIPS 2026 Workshops']
    if not members:
        return items
    previous = next((item['notification_policy_state'] for item in [*members, *previous_by_id.values()]
                     if item.get('notification_policy_state', {}).get('id') == POLICY_ID), {})
    policy = dict(previous, id=POLICY_ID, venue_group=POLICY_SCOPE,
                  deadline_label='Mandatory accept/reject notification cutoff for workshop contributions',
                  _source_observed=False,
                  _schedule_purpose=(
                      'Extract ONLY the shared mandatory cutoff for workshop organizers to notify '
                      'authors of contributed papers. Use the requested primary target. '
                      'Exclude workshop-proposal acceptance and suggested contribution deadlines. '
                      'This is a notify-by requirement, not the decision date of an individual workshop.'
                  ))
    def extract_policy(context, documents):
        result = extract(context, documents)
        entries = result.get('entries') if isinstance(result, dict) else None
        if (not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict)
                or entries[0].get('target') != POLICY_ID
                or entries[0].get('milestone') not in {'notification', 'notification_by'}
                or entries[0].get('kind') not in {'date', 'deadline'}):
            raise SourceUnavailable('Shared workshop notification cutoff not identified')
        return result

    refresh_schedules([policy], {POLICY_ID: previous} if previous else {}, clock, force_refresh,
                      fetch_html=fetch_html, extract=extract_policy)
    policy.pop('_schedule_purpose', None)
    policy.pop('_source_observed', None)
    primary = next((entry for entry in policy.get('schedule_observation', {}).get('entries', [])
                    if entry['target'] == POLICY_ID), None)
    for index, item in enumerate(members):
        # One cache owner per family; every row needs only the compact policy projection.
        item.pop('notification_policy_state', None)
        if index == 0:
            item['notification_policy_state'] = copy.deepcopy(policy)
        current = copy.deepcopy(item.get('notification_policy', {}))
        if primary:
            current = project_milestone(primary)
            current.pop('planning_at', None)
        current.setdefault('kind', 'date')
        current.update(milestone='notification_by', label='Workshops must notify authors by',
                       status=policy.get('schedule_status', 'unverified'),
                       checked_at=policy.get('schedule_checked_at', ''))
        item['notification_policy'] = current
        item['notification_issues'] = list(policy.get('schedule_issues', []))
        item['notification_issues'].extend(notification_conflicts(item))
    return items
