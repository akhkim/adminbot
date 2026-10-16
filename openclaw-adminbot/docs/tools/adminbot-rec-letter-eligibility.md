# AdminBot recommendation-letter eligibility (operator guide)

Works out whether a member currently meets the lab's bar for a recommendation letter, and shows
the answer next to the letter request: as a badge in the admin queue, as a panel in the request
detail, and as a short note on the member's own letters form.

**It is advisory.** Nothing here refuses, hides or delays a request. A member can always submit,
and the admin deciding reads the result as one input among others. The decision stays with the lab.

## The policy, and where each clause lives

| Policy clause                                                                                                                                                   | Code                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A desk rejection caused by a hallucinated citation freezes the member for **one year from the latest incident**; a new incident restarts the clock              | `recLetterFreeze` in `extensions/adminbot/src/workflows/logistics/rec-letter-eligibility.ts` |
| Frozen overrides everything else                                                                                                                                | `recLetterEligibility`: status is `frozen` whatever the other criteria say                   |
| At least **5 months** (not necessarily consecutive) averaging **at least 20 hours a week**                                                                      | `recLetterHours`, `averageWeeklyCommittedHours`                                              |
| Some **3 consecutive months** with at least **80%** of Monday meetings attended, and a Wednesday meeting attended in at least **80%** of the weeks that had one | `recLetterAttendance`                                                                        |

Every threshold is a named constant at the top of that file (`adminBotRecLetterFreezeYears`,
`adminBotRecLetterMinWeeklyHours`, `adminBotRecLetterRequiredHourMonths`,
`adminBotRecLetterAttendanceWindowMonths`, `adminBotRecLetterMinAttendanceRate`,
`adminBotRecLetterMinRosterCoverage`). The module is pure: the member, the incidents, the
meetings and the clock come in as arguments, so the tests pin each edge without a store.

## Results

| Status              | Meaning                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `eligible`          | Not frozen, the hours criterion is met, and some attendance window passes             |
| `frozen`            | A freeze is running. Shown with the day it ends                                       |
| `not_yet`           | Not frozen, but a criterion was judged and is not met yet                             |
| `insufficient_data` | Not frozen, nothing judged has failed, but at least one criterion could not be judged |

Every result carries the detail behind it: each counted month with its average committed hours,
the best attendance window with its Monday and Wednesday counts, rates and roster coverage, and a
`missing` list naming what still stands between the member and `eligible`.

## Assumptions

These are the places the data is weaker than the policy's wording. The UI words its results
around them.

- **Committed hours, not logged hours.** The hours come from the member's rows on the availability
  page: what they planned to give each week, not time anyone recorded. The UI says "committed
  hours" everywhere. Overlapping rows add up, the same way the availability page draws them.
  Months are counted from the member's join month (or their earliest row) up to their graduation
  month or the last finished month; **the month in progress is never counted**, since it could
  pass on a plan that has not happened yet.
- **Attendance is only as complete as the rosters on file.** The lab's Zoom is an educational
  account with no API (see [Meeting recordings](/tools/adminbot-meetings)), so a roster exists only
  when a host exported the participant CSV and dropped it in the folder, or an admin edited the
  roster on the Meeting Recordings tab. A transcript can tick the people who spoke, but it misses
  anyone who stayed muted, so importing the CSV is what makes a meeting count fairly.
- **A meeting with no roster says nothing about anyone.** It is left out of the rate rather than
  counted as an absence.
- **The 70% coverage rule.** A three-month window is judged only if at least 70% of its Monday
  meetings _and_ 70% of its Wednesday weeks have a roster (`adminBotRecLetterMinRosterCoverage`).
  Below that, the rate rests on a handful of exports and could make a regular look absent. Such a
  window is "not enough data", never a fail. If no window in the member's history can be judged,
  attendance is `insufficient_data`.
- **Days are read in America/Toronto.** A Monday-evening meeting is Tuesday in UTC; the weekday
  and the month come from the Toronto calendar. Meetings on the same Toronto date are one occasion,
  so a recording split in two still counts once.
- Each month of a window needs at least one Monday on record; otherwise the window is not judged.

## Freeze incidents

An admin records an incident from the **Letter freezes** section below the admin's Logistics
request queue: the member, the date of the desk rejection, and optionally a paper id and a note. The
date may be in the past; a date in the future is refused as a typo. Deleting an incident is how a
mistaken entry is undone; the freeze recomputes at once.

No member is frozen by default and nothing in the source names one. A freeze exists only because
an admin recorded an incident.

Both actions are audited as `rec_letter_freeze.recorded` and `rec_letter_freeze.deleted`, with the
incident id, member id and date. **The note is kept out of the audit log**, because it may describe
the paper and the log is read more widely than the incident list.

Incidents are stored in the `adminbot_rec_letter_freeze_incidents` SQLite table.

## Routes

| Method and path                                           | Who                  | Returns                                                                                                    |
| --------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /logistics/eligibility/me`                           | The signed-in member | Their own result. No incident ids, counts or notes; while frozen, only that they are frozen and until when |
| `GET /logistics/eligibility?member_id=` or `?request_id=` | Admin session        | The full result, the member's name and their incidents                                                     |
| `GET /logistics/eligibility/summary?member_ids=a,b`       | Admin session        | Status (and freeze end) per member for the queue badges, up to 100 ids. Unknown ids are skipped            |
| `GET /logistics/freeze-incidents[?member_id=]`            | Admin session        | Incidents, newest first, notes included                                                                    |
| `POST /logistics/freeze-incidents`                        | Admin session        | Records one: `{ member_id, occurred_on, paper_id?, note? }`                                                |
| `DELETE /logistics/freeze-incidents/:id`                  | Admin session        | Removes one                                                                                                |

The member's read is its own path rather than a query parameter, so no parameter can turn it into
a read of somebody else. The incident routes take an admin session, not the service token: an entry
that withholds somebody's letter should have a person behind it.

## Limits

- Time-off rows on the availability page are not subtracted from committed hours.
- Merging or purging a member does not move their incidents to the surviving record.
- Incidents are stored in SQLite only; there is no Postgres store for them yet.
- The "frozen until" shown on each row of the incident list is that incident's own end date; the
  member's freeze runs from the latest one.
- Copy is in English. Other locales fall back to English until the next i18n sync.

## Follow-ups

- **Automatic attendance.** The educational Zoom account has no API. A Pro account (for example a
  partner institution's) could read participants from the `past_meetings` endpoint, which would
  remove the CSV step and the coverage gap.
- **Logged hours.** Replace committed hours with time actually recorded, once the lab records it.
- **Linking recordings to the calendar series.** Today a meeting counts as a Monday or Wednesday
  meeting by its Toronto weekday. Tying each recording to its calendar series would tell a group
  meeting apart from another call on the same day.
