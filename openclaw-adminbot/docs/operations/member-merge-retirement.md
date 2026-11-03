# Retired member IDs

A member merge now retains the duplicate ID in `adminbot_member_retirements` before deleting
its roster row, in one SQLite transaction. The mapping contains only the retired ID, survivor
ID and retirement time. It survives ordinary audit pruning and service restarts.

Profile upserts (including CSV/sheet imports and signup preparation) refuse a retired ID with
409 before saving a record or running onboarding hooks. Renaming another member to a retired
ID is also refused. The caller must reconcile the source with the existing survivor; no stale
profile, access level or invitation is automatically redirected or applied to that survivor.

At store initialization, retained `lab_member.merged` audit records seed missing retirements.
This is additive metadata: it does not delete or merge already-recreated roster rows, move their
references, revoke access or execute outstanding proposals. Existing duplicates still need an
administrator's identity review. Merges whose audit evidence was already pruned cannot be
reconstructed safely; no name or email similarity is treated as a prior merge.

This prevents reuse of a known retired ID. It does not identify every duplicate person created
under a different new ID. Ordinary member deletion is unchanged. There is no automatic undo or
ID reuse path: an intentional reversal needs a separately reviewed recovery plan.

Deploying this code initializes the new metadata table. Preparation and synthetic SQLite tests
are not a production migration or rollout. Existing storage, backup, review and deployment gates
still apply; do not bypass the SQLite storage checks.
