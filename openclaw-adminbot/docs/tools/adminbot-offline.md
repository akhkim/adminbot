# Offline editing

AdminBot's member website can reopen after a previous online visit and keep working without
Aurora or the AI gateway. The production service worker installs the application shell and its
JavaScript/CSS assets. Previously fetched authenticated data is available from a browser-local
cache. Pages never opened online may have no cached records to display.

## Drafts

Recommendation-letter and meeting-request forms autosave on input, including row additions and
removals. The existing signature-correction editor also autosaves its text and attached files.
New signature requests still use the external Google Form; AdminBot cannot make that site work
offline. These changes do not add offline AI inference or simultaneous character-level editing.

Each edit first commits to IndexedDB in this browser profile. The status appears above the form:

- **Saving on this device…**: local storage has not yet committed.
- **Saved on this device · waiting to sync**: the local copy is durable, but Aurora has not
  acknowledged it.
- **Saved on this device · syncing…**: the local copy is being sent.
- **All changes saved**: the current working copy has been acknowledged by Aurora.
- **Conflict**: another tab or device has a newer version. The local copy is retained. Download
  both versions to compare, then explicitly replace the server copy or use its version.

Sync runs after a local save, on browser online/focus events, and every ten seconds while the
website is open. The timer also handles Aurora returning while the browser's internet stayed
connected. Closing the browser stops synchronization; reopening resumes from IndexedDB.
Use **Download saved copies** to export retained local versions (including files encoded in JSON).
Older drafts in the previous `adminbot-logistics` database are left intact. Because those drafts
were not scoped to a backend address, importing them into the current account requires the
**Restore draft saved by the previous version** button instead of silently uploading them.

Storage belongs to the website origin and browser profile. Clearing site data deletes local work;
private browsing and storage quota failures can prevent persistence. A failed local write is shown
as an error and must not be reported as saved. Large drafts remain local if the server refuses
the upload; the draft endpoint accepts at most about 8 MB of JSON, including encoded attachments.

## Authentication and execution

A previously verified, unexpired session can restore the member UI while disconnected. Its cached
identity is scoped to the backend address and session-token digest. Gateway credentials are never
included in that snapshot. Expired snapshots cannot restore a session, and a live 401/403 invalidates
it. Cached identity is a local UI convenience, never server authorization.

`GET /member-drafts/:key` and `PUT /member-drafts/:key` require a live member session on every call.
The service chooses the owner from that session, ignores caller-supplied owner fields, and refuses
service-token access. Keys are limited to `document-signature`, `recommendation-letters`, and
`book-meeting`. A PUT carries `baseRevision`, `mutationId`, and `data`; a stale version returns 409.
Identical retries return the previous result. Clearing uses a null draft with a new revision, so a
stale browser cannot silently resurrect a cleared copy. SQLite commits the comparison and write
in one transaction, and retains drafts across server restarts.

Saving a draft does not submit a request, send a message, approve an action, or invoke a connector.
Submit remains an explicit operation through the existing service workflow. The draft endpoint
never interprets saved data as instructions or executable actions.

The service worker tries the network for page navigation and falls back to the installed shell
when the request fails, including a fresh offline tab and an unreachable host while the browser
still reports online. A 401 with a reverse-proxy authentication challenge redirects once to a
browser-managed navigation; 401/403 responses never fall back to cached content. The app removes
the temporary bypass parameter after loading. Production assets must finish installing before
offline reopening is available. Development mode deliberately unregisters service workers.

## Chrome and phones

The **Offline access** panel appears in the signed-in workspace on desktop and phone layouts.
**Ready on this device** means the installed worker verified its shell assets, not that every
record has been downloaded. Open the records you need online first. The panel also shows pending
drafts and offers manual sync and a persistent-storage request. The browser can decline storage
protection; clearing site data still removes local work.

For desktop Chrome, load the repository's `chrome-extension/` directory as an unpacked extension
and enter the portal URL. This is a launcher into the same offline web workspace, sharing the
portal's existing browser storage and sign-in. It does not copy sensitive records into extension
storage. It has not been published to the Chrome Web Store.

For phones, open the portal online and install/add it to the Home Screen using the browser menu.
Open the installed app online to prepare its own storage before disconnecting. This release uses
the responsive web app, not a native Android/iOS binary. Local on-device LLM inference remains the
advanced interview assignment in `plans/local-queue.md` at the repository root.

Only revisioned member drafts synchronize automatically. Failed generic writes (including
submissions and approvals) are not queued or replayed. Old generic outbox records remain retained
but inert; their count tells the member to review and submit again while online. Saved drafts
are restored for synchronization even when reopening on the dashboard instead of a form.

## Verification

Run from `openclaw-adminbot/`:

```sh
pnpm test extensions/adminbot/src/api/server.member-drafts.test.ts extensions/adminbot/src/persistence/member-drafts.test.ts
pnpm test ui/src/ui/adminbot/data/logistics-draft.test.ts ui/src/ui/adminbot/views/logistics.test.ts
pnpm ui:build
cd ui
pnpm exec vitest run --config vitest.config.ts src/ui/adminbot/offline/draft-sync.browser.test.ts src/ui/adminbot/offline/website-offline.node.test.ts src/ui/adminbot/auth/session.offline.node.test.ts
```

The website test uses production assets, Chromium, real IndexedDB, and synthetic API responses.
The HTTP tests separately exercise the actual service's authentication and revision checks.

### Local Queue regression checks

The targeted UI suite also includes `offline/service-worker.node.test.ts` for navigation,
authentication bypass, and private-route cache exclusion, and
`offline/chrome-extension.node.test.ts` for loading the real unpacked extension in an isolated
Chromium profile. Run them with the UI Vitest config. From the repository root,
`node --test chrome-extension/popup.test.mjs` checks URL validation and launcher behavior.

The production-browser scenario closes the editor tab offline, opens a new phone-sized tab,
recovers its exact draft and pending count, reconnects, and resolves a two-tab conflict. The
IndexedDB suite also verifies that reconnecting restores pending drafts without opening a form.
These checks use synthetic data. Phone-sized Chromium is not physical Android/iPhone testing;
Chrome Web Store publication and live deployment have not been performed.
