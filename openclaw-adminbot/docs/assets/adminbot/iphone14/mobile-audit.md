# iPhone 14 UI audit

Viewport: 390 × 844 CSS pixels; landscape: 844 × 390. Real app shell and renderers, synthetic member/admin records, no gateway connection or production writes. Both light and dark themes were checked. External frames were blocked. This is responsive browser evidence, not a physical iPhone/Safari certification.

## Coverage

Each route below passed the initial rendered layout check in both themes: no page-content horizontal overflow and no visible button, text input, select or summary shorter than 44px. Small checkbox inputs are excluded; their clickable member-type labels were separately verified at 44px. Backend-dependent loading, empty and error panels are included, so this does not verify every populated state or backend operation.

| Route | Initial light/dark layout |
| --- | --- |
| agents | Pass |
| dashboard | Pass |
| profile | Pass |
| gettingStarted | Pass |
| myWork | Pass |
| labSharing | Pass |
| activity | Pass |
| adminbot | Pass |
| adminbotRegistrations | Pass |
| adminbotBadges | Pass |
| adminbotOnboarding | Pass |
| adminbotReimbursements | Pass |
| adminbotSettings | Pass |
| adminbotMembers | Pass |
| adminbotOpportunities | Pass |
| adminbotProfileOverview | Pass |
| adminbotTabUsage | Pass |
| adminbotProfessor | Pass |
| adminbotTravel | Pass |
| adminbotTimeAvailability | Pass |
| adminbotMeetings | Pass |
| adminbotSignatures | Pass |
| adminbotRecLetters | Pass |
| adminbotMeetingRequests | Pass |
| adminbotPapers | Pass |
| adminbotWorkshopNudges | Pass |
| adminbotAnnouncements | Pass |
| adminbotConferencePapers | Pass |
| adminbotReferenceChecker | Pass |
| adminbotCalendar | Pass |
| adminbotGrantReport | Pass |
| adminbotMailingList | Pass |
| adminbotDeadlines | Pass |
| overview | Pass |
| channels | Pass |
| sessions | Pass |
| usage | Pass |
| cron | Pass |
| skills | Pass |
| nodes | Pass |
| chat | Pass |
| config | Pass |
| communications | Pass |
| appearance | Pass |
| automation | Pass |
| mcp | Pass |
| infrastructure | Pass |
| aiAgents | Pass |
| debug | Pass |
| logs | Pass |

## Interaction checks

- Drawer opens, links have 44px targets, selecting Time Availability closes the drawer and changes the active route. Member navigation hides admin groups.
- Add Member panel fits portrait and landscape and scrolls internally; expanded member-type choices have 44px labels. No member was submitted.
- Profile help opens by tap and remains inside the viewport. Long project titles wrap.
- Recommendation schools and contribution facts become labelled vertical fields. School input was edited; no request was saved.
- Meeting request Add a meeting creates a labelled vertical row with 44px inputs. No request was submitted.
- Receipt upload input stays within its composer; no receipt uploaded.
- Expanded feedback has 44px rating/close/send targets, a 16px textarea and fits landscape. No feedback sent.
- At 1280 × 900, school/fact rows retain desktop table-row layout.
- Earlier chart checks in this PR cover paging, keyboard scrolling and selected-period details.

## Evidence

Letters before/after use the same synthetic request at 390 × 844; the before CSS is commit caf1e9aa17e6edfb57fade34d1c6ac57f0a1760e. Screenshots are native browser captures. The before form requires horizontal scrolling to reach columns; the after form labels each stacked field.

## Validation and limits

113 logistics/feedback tests pass, including a regression check that every editable request cell has a visible phone label and an accessible control label. Scoped lint and production UI build pass. Existing availability/profile/meeting/opportunity checks are recorded in the PR.

Not verified here: iOS software keyboard, VoiceOver, physical-device performance, authentication/network timing, real saves, uploads, emails, calendar side effects, embedded third-party pages or production deployment. These need a connected staging session and device check; this audit does not claim them complete.
