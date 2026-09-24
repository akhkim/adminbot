# Local Queue: offline access and advanced mobile interview task

Status: basic browser offline access and Chrome launcher implemented locally; advanced on-device inference remains a candidate assignment. See `../openclaw-adminbot/docs/tools/adminbot-offline.md` for supported forms and installation. Native apps and physical phone validation are not included.

## Product goal

Make AdminBot useful during frequent disconnections: users can reopen downloaded work,
read it, and edit drafts without waiting for the network or an AI service. Reconnecting
should recover work predictably. The desired experience is the continuity of a messaging
app such as WhatsApp: local content and composition remain useful during an outage.

Deliver two levels:

| Level | Offline capabilities | Intended audience |
| --- | --- | --- |
| Basic | Read explicitly downloaded content, create and manually edit drafts, inspect pending sync | All users; desktop Chrome and phones |
| Advanced | Everything in Basic, plus optional small-model inference entirely on the phone | Advanced coder interview assignment, followed by a measured prototype |

## Existing foundation

The current checkout contains browser IndexedDB draft persistence, service-worker app-shell
caching, visible save states, authenticated draft synchronization, and revision conflicts.
See `../openclaw-adminbot/docs/tools/adminbot-offline.md`. These are a starting point,
not proof that Chrome extension packaging or native phone support is complete. This
specification does not modify that implementation or certify its current tests/deployment.

## Track 1: offline reading and manual editing

### Clients

- Desktop Chrome: provide an extension entry point and an offline workspace that can reopen
  downloaded content. First spike must establish whether the workspace lives in the extension
  or the website, and document their storage separation and any authenticated bridge. Request
  only narrowly scoped permissions. Do not assume website IndexedDB is directly available to
  an extension.
- Phones: provide a mobile client with persistent local storage and an explicit download-for-
  offline flow. Evaluate a mobile web install and a native client against the same acceptance
  tests; choose based on actual device results. Phone support must have its own delivery path
  rather than depending on the desktop extension.
- Expose what is available offline, its last refresh time, storage usage, and a per-account
  clear-downloads control. Uncached pages must explain what is missing.

### Local Queue behavior

1. Download only authorized, policy-eligible records selected for offline use. Partition all
   local records by server and account. Define retention and sensitive-data eligibility before
   enabling broad record caching.
2. Commit each manual edit locally before showing **Saved on this device**. Persist pending
   sync metadata with the draft; app termination must not lose an acknowledged local edit.
3. Show distinct states: saving locally, saved locally, syncing, synced, conflict, and error.
   Show stale read data as stale. A storage failure must never appear as a successful save.
4. On reconnect or reopen, reauthenticate as needed and sync drafts with stable mutation IDs
   and base revisions. Retry transient failures with bounded backoff; authentication failures
   pause sync. Do not depend on background execution for correctness.
5. Preserve both copies when revisions conflict. Offer a review/merge workflow; never silently
   overwrite a newer edit from another device. Serialize dependent changes per document while
   allowing unrelated drafts to make progress.
6. Keep a pending draft separate from a submitted request. Offline composition does not approve,
   submit, send, or execute anything. After reconnect, explicit submission enters the existing
   proposal -> approval -> execution flow, with fresh authorization and policy checks.

Use IndexedDB for the browser foundation and evaluate a transactional native store for the phone
client. Native storage is a local replica, not direct access to the service's SQLite database.
Clients communicate through the authenticated AdminBot API. Local cache contents never grant
server permissions. Revocation cannot be learned while disconnected; document that limit and
apply a bounded offline-access policy, device protection, and account-switch/logout isolation.

### Acceptance scenarios

- After a successful download, enable airplane mode, terminate the client, reopen, read the
  downloaded record, edit a draft, terminate again, and recover the exact acknowledged edit.
- Reconnect after several edits: the server receives the final draft without duplicates.
- Edit the same draft on two devices: retain both versions and surface the conflict.
- Expire/revoke the session or switch accounts: no cross-account replay or unauthorized upload.
- Simulate quota exhaustion, failed writes, oversized attachments, intermittent networking,
  and a server outage while the device still reports online; preserve honest save states.
- Verify on desktop Chrome, a physical Android phone, and a physical iPhone. Record browser/OS
  versions and limits; do not infer phone reliability from desktop emulation.
- Demonstrate that restoring connectivity never sends a message or executes a lab action merely
  because an offline draft exists.

## Track 2: advanced coder interview assignment

### Candidate brief

Build a phone prototype that reads a locally downloaded synthetic document, supports durable
manual edits, and uses a small on-device language model to summarize the document or suggest
a rewrite in airplane mode. The user previews a suggestion and explicitly accepts it before
it changes a draft. Deliver one platform well; a second platform is optional.

Provide the candidate with a starter mobile client, synthetic fixtures, a mock sync API with
revision conflicts, and the offline acceptance contract. Use a mutually agreed timebox; do not
require candidates to implement all of Track 1 or possess a flagship phone. Offer a loan device
or a reproducible simulator development path, with physical-device validation clearly separated.

### Required behavior

- Download the model explicitly while online; disclose model size, license, compatibility,
  and storage cost. Validate its integrity before use. Never silently fetch a model offline.
- Run inference locally with no remote fallback, private-content telemetry, or bundled vendor
  credentials. Demonstrate this with airplane mode and a network inspection check.
- Keep reading and manual editing functional when the model is missing, unsupported, fails,
  or runs out of memory. Show model availability separately from sync availability.
- Support cancellation and a responsive editor. Bound input/context size and explain how long
  documents are handled. Label output as a suggestion; never auto-approve or auto-execute it.
- Retain the same account isolation, local-save guarantees, conflict handling, and server
  authorization boundaries as the basic client.

### Deliverables and evaluation

Submit runnable source, setup instructions, a short offline demo, focused persistence/sync
tests, and a measurement report naming the device, OS, model, quantization, and runtime.
Measure cold/warm load time, time to first output, completion latency, peak memory, model
storage, and observed battery/thermal behavior with a stated protocol. Distinguish measurements
from estimates; explain quality failures on supplied summary/rewrite examples.

| Criterion | Weight |
| --- | --- |
| Durable offline behavior, recovery, and conflicts | 30% |
| Real local inference and reproducible device measurements | 25% |
| Privacy, account isolation, and authorization boundaries | 20% |
| Responsive UI, cancellation, and graceful fallback | 15% |
| Code clarity, focused tests, and candid limitations | 10% |

Do not grade by model size or raw speed across different hardware. Reward sound tradeoffs and
honest evidence. A cloud call presented as local inference or an authorization bypass is a
correctness failure. Set performance targets only after measuring the supplied reference device.

## Delivery sequence

1. Verify the existing browser draft foundation against the acceptance scenarios.
2. Prove Chrome extension reopening/storage and phone persistence in small device spikes.
3. Ship Basic with scoped downloads, manual edits, visible sync, and conflict recovery.
4. Run the advanced interview assignment against the same contract.
5. Consider optional on-device AI for release after hardware, quality, privacy, and runtime
   licensing results justify it. Basic must remain independently usable.
