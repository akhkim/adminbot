# Local chat UI verification — 2026-09-27

These are computer-use screenshots of the actual Lit component and production AdminBot
stylesheet. The temporary fixture uses a synthetic, approved head-professor account in an
in-memory AdminBot API. Its model calls go through an SSH loopback forward to Aurora's actual
`nvidia/Qwen3.5-122B-A10B-NVFP4` endpoint. No production account, private query, record,
credential, or external model was used. This is implementation evidence, not a deployed release.

The rebuilt interface follows Open WebUI's sidebar / conversation / composer layout, with
AdminBot theme tokens and icons. No upstream source was copied or new dependency installed.
Verified in the browser: real Qwen Markdown replies, copy feedback, conversation search,
switching and draft retention, stopping a running inference request and sending afterward,
full-screen open/close and Escape, light mode, mobile drawer open/close, and readable controls.
The desktop breakpoint is 1280×800; mobile is 390×844. Screenshots were visually inspected.

- [Before: small card](desktop.png)
- [After: desktop](workspace-dark.jpg)
- [After: light mode](workspace-light.jpg)
- [Empty state](workspace-empty.jpg)
- [Mobile conversation](workspace-mobile.jpg)
- [Mobile drawer](workspace-mobile-drawer.jpg)

The original card's fixed-token test returned `LOCAL_UI_OK_42`; a follow-up recalled the token.
The rebuilt workspace's code example and message history are synthetic test content. The second
sidebar item in the final screenshots is a preserved draft, demonstrating independent drafts.

## Readable review details

`review-context.jpg` is a fresh 1280×720 capture of the actual component with
production styles, synthetic authentication, and a real Aurora Qwen reply.
`review-response-detail.jpg` (825×260) and `review-composer-detail.jpg` (825×165)
are native-resolution crops of that image; content and styles were not altered.
These preserve legible text at typical PR widths. The older compact-card image
is historical context with different framing/theme, not a controlled visual
benchmark. Verify the rendered PR after publishing these assets.
