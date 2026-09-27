# Local chat UI verification — 2026-09-27

These are browser screenshots of the actual Lit local-chat component with the production
AdminBot stylesheet, mounted in a temporary development fixture. The fixture uses a synthetic,
approved head-professor account in an in-memory AdminBot service. Its model calls go through an
SSH loopback forward to Aurora's actual `nvidia/Qwen3.5-122B-A10B-NVFP4` endpoint.

The fixed-token request returned `LOCAL_UI_OK_42`. A follow-up also recalled that exact token.
Keyboard submission, loading status, clearing history, and a 390-pixel mobile layout were
checked. No production account, private query, record, credential, or external model was used.
These screenshots are component evidence, not proof of production deployment.

- [Desktop](desktop.png)
- [Mobile](mobile.png)
