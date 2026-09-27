# Local chat for the head professor

My Desk includes a separate text-only **Local chat** card for the configured head professor.
The server checks `head_professor_member_id`, admin privilege, and a non-impersonated member
session on every request. Other members, other admins, service tokens, and impersonated sessions
cannot use it. Missing configuration denies access.

## Routing and privacy

This card calls the AdminBot service directly, bypassing gateway agents and the privacy broker.
It sends only the displayed conversation and a fixed system instruction to a loopback model
endpoint. There are no tools, retrieval, external providers, or fallback calls. Remote endpoints,
redirects, and a response from a different model fail closed. Local failures return a fixed error
without exposing provider exception details.

Conversations stay in component memory. AdminBot does not write them to its database or audit
ledger. Clear chat, session changes, and leaving My Desk clear the component history; late
responses are discarded. This does not promise that the local model operator or reverse proxy
has disabled its own logging. Review that separately before sharing secrets. The ordinary chat
and other tools retain their existing routing; the local-only guarantee applies to this card.

The service allows one active turn, a 60-second timeout, 2,048 output tokens, up to 23 alternating
messages, 8,000 characters per message, and 32,000 characters per request. An overlapping request
gets 429 rather than entering a queue.

## Configuration

The existing defaults are `http://127.0.0.1:8000/v1` and
`nvidia/Qwen3.5-122B-A10B-NVFP4`. `ADMINBOT_LOCAL_BASE_URL` and `ADMINBOT_LOCAL_MODEL` may override
them. The URL must remain loopback. `VLLM_API_KEY` stays in the service environment and is never
sent to the browser. GET `/local-chat` exposes model and routing metadata only; POST accepts
`{ messages: [{ role: "user", content: "..." }] }`. Both require the authorized member session.

Deploy the backend and Control UI from the same commit. This branch was tested against the live
Aurora model using a synthetic, in-memory account; it has **not** changed the production release
or verified Zhijing's deployed session. Deployment acceptance must check her normal My Desk
session, another admin's denial, the returned model, and an unavailable-model failure without a
remote call. No gateway default-model change is needed.

## Verification

```sh
node scripts/run-vitest.mjs run extensions/adminbot/src/api/server.local-chat.test.ts extensions/adminbot/src/privacy/local-chat.test.ts extensions/adminbot/src/guidebook/guidebook.test.ts
node scripts/run-vitest.mjs run ui/src/ui/adminbot/views/local-chat.test.ts ui/src/ui/adminbot/views/professor.test.ts
OPENCLAW_BUILD_ALL_NO_PNPM=1 node scripts/build-all.mjs
```

For an optional real local-model check, forward Aurora's loopback port to a local loopback port
and set `ADMINBOT_TEST_LOCAL_CHAT_URL=http://127.0.0.1:19000/v1` for the API test. It creates only
synthetic in-memory records and asks for a harmless fixed token. Do not use production sessions
or copy production records for this test.

[Desktop evidence](../assets/adminbot/local-chat/desktop.png) ·
[Mobile evidence](../assets/adminbot/local-chat/mobile.png).
