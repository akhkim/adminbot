# Acquaintance welcome preview

Actual Lit component with production styles, synthetic member data and mocked API. No email or Slack connection and no live effects. This is component evidence, not authenticated production integration or delivery proof.

- default-desktop.jpg: correspondence recipient and complete standard welcome before separate approval.
- custom-desktop.jpg: custom subject/body and exact preview.
- mobile-queued.jpg: 390x844 responsive interaction after mocked queue, explicitly no-send; document scroll/client width both384.
- preview-detail.jpg: native browser crop of recipient, exact copy and approval control for PR readability.
- default-light.jpg: same default preview in light theme.

Interaction verified: empty custom body disables preview; changing custom copy removes the old preview; queue returns separate approval, not sending. HTTP regression tests verify server-side recipient/hash binding and duplicate/resend handling. JPEG encoding and saved files inspected at native size. Rendered PR inspection recorded in owner receipt.

To reproduce, copy fixture.html to ui/.artifacts/acquaintance-welcome-preview.html and serve the UI with Vite. The fixture installs a synthetic session through the app's public session helper on localhost; it neither reads real credentials nor calls a real provider. Use ?theme=light for light theme.
