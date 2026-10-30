# Collaborator chats

Actual Lit component and production styles with synthetic mocked API responses. No Slack connection or live effects. These are component-fixture screenshots, not a production deployment or authenticated end-to-end browser claim.

- `desktop.jpg`: intended participants and exact opening-message approval preview.
- `approval-detail.jpg`: browser-native detail of that preview, using page coordinates after scrolling.
- `mobile.jpg`: same component at 390×844 viewport; observed content width384 equals viewport client width384, no horizontal overflow.
- `unknown-light.jpg`: light-theme retained group receipt and explicit unknown-message/no-retry guidance.

The files contain JPEG bytes and use matching extensions. Native saved images inspected. Browser interaction and saved-image passes completed; rendered PR pass is tracked in the owner receipt.

To reproduce the fixture: copy `fixture.html` to `ui/.artifacts/collaborator-chat-preview.html`, start the existing Vite UI server, open that path, and click Load. Use `?theme=light&state=unknown` for the partial-outcome view. The fixture imports the actual component and styles; only its API responses are mocked.

Unknown effects stay locked. The UI exposes the retained conversation receipt for manual provider reconciliation; it deliberately has no force-retry or inferred-delivery control. Slack/provider permissions, guest compatibility and live group/message outcomes were not exercised.
