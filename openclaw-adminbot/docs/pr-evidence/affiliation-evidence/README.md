# Affiliation audit — synthetic evidence

No UI changed. The tool still prepares a T4 Overleaf proposal; the service still approves the immutable payload and the existing connector checks readiness before calling the bridge. This is not live author/roster verification and no manuscript was edited.

Synthetic cases:
- Structured `Example University`, notes `Affiliation: Former Institute`: previously the notes were marked ready; now structured wording is retained as a candidate and conflict/paper-work-period confirmation is required.
- Structured `Vector Institute`, incidental notes `met Jinesis colleagues`: previously any Jinesis mention could select the combined lab/UofT/Vector string; now the recorded Vector-only association is preserved and confirmation required.
- Structured `University of Toronto`, `Jinesis Lab`, or `Example University; Vector Institute`: preserve the exact independent wording; never add the other institutions from membership/email/access.
- Notes only or unknown/ambiguous author: unverified/confirmation or missing, never ready.
- An old issue marked ok but lacking paper-specific confirmation: connector refuses before any mocked bridge call. An explicitly confirmed synthetic affiliation payload still reaches the injected bridge.

After resolving an issue using actual author/canonical evidence, record the exact expectedAffiliation and confirmation.source plus confirmation.workPeriod on the issue before marking it ok. These are evidence references and human assertions, not automatic eligibility proof. Updating the payload requires the normal fresh approval/hash path. Never copy an old approval or simply toggle status to bypass confirmation. Existing manual edits remain in their original proposal/approval/execution flow.

All tests use synthetic identities, institutions and links. No canonical sheet/private guidebook copied, no access/funding inference, no bulk author edits, model calls, provider requests, deployment or service changes. Browser screenshot passes are not claimed for this backend-only repair.

Confirmation coverage is bound by authorReference.index and authorReference.value to the original immutable paper.authors entry. Display author names may differ from input member IDs. Keep the generated references; duplicate, unrelated, missing or stale references are refused before bridge calls. Name/source/work-period text is still a reviewed assertion, not independent proof of identity or eligibility. Synthetic tests include the ID-to-display-name case and tabs/repeated spaces in equivalent institution strings.
