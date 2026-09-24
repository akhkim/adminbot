# Shared LLM admission gateway

Run exactly one gateway for AdminBot and PaperMentor on their local application host.
It needs no Kubernetes, Redis, or database. Both applications must send every completion
through it; separate gateway instances or direct provider calls do not share limits.

The gateway atomically admits up to 100 public requests and 8 local GPU requests.
A public request waits whenever **either** pool is full, including exactly 100 or 8.
Local privacy work waits at 8; it can continue when the public pool is full.
Each pool is FIFO. Local waiters drain first so privacy classification can progress.
Limits cover complete response bodies, including streaming, not just response headers.
NVIDIA remote reasoning, when used, consumes public capacity too.

## Start

Set `LLM_GATEWAY_TOKEN` to a shared secret in the host secret environment, and supply
`OPENROUTER_API_KEY`, `VLLM_API_KEY`, and optionally `NVIDIA_API_KEY` there.
From `openclaw-adminbot/`, run:

```sh
node --import tsx start-llm-gateway.ts
```

The gateway binds only `127.0.0.1:8766` (`LLM_GATEWAY_PORT` overrides the port).
It rejects missing/wrong bearer tokens and requests carrying browser Origins.
It forwards only fixed, server-configured provider endpoints and never logs payloads.
Request bodies are bounded at 64 MiB to accommodate existing base64 receipt uploads.

Set these in **both applications' server environments**:

```sh
LLM_GATEWAY_URL=http://127.0.0.1:8766
# LLM_GATEWAY_TOKEN=<same secret as gateway, from host secret manager>
```

AdminBot's privacy broker, CV completions, reimbursement intake, guidebook/meeting
completion helper, and social drafts use this setting. Embeddings are not LLM completion
requests and keep their existing path. Provider keys may still be needed in application
configuration for existing provider-selection checks; only the gateway's provider keys
are forwarded upstream. Do not put any of these secrets in browser bundles.

PaperMentor's OpenAI-compatible client should use base URL
`http://127.0.0.1:8766/public/v1` and the gateway token as its API key.
Its approved local/private completion path should use `/local/v1` instead.
Keep PaperMentor's privacy checks before selecting the public route. The gateway does
not classify prompts or make routing decisions with an LLM. Node clients can also import
`routeLlmFetch` through the AdminBot public API.

Any inherited OpenClaw agent provider configured separately from these AdminBot workflows
must likewise use these base URLs to participate. Do not leave direct provider URLs in a
production configuration that requires global limits.

A configured gateway failure fails the call; clients never silently bypass it.
Removing `LLM_GATEWAY_URL` retains legacy development mode, which is **not** shared
admission control.

## GPU nodes

Use local SSH tunnels to reach each GPU. Set `ADMINBOT_LLM_NODES` in the gateway environment:

```sh
ADMINBOT_LLM_NODES='aurora|http://127.0.0.1:8000/v1|RTX6000,maple|http://127.0.0.1:8001/v1|RTX6000,conserto3|http://127.0.0.1:8002/v1|H100'
```

These are example tunnel ports, not discovered live endpoints. Aurora and Maple are RTX6000;
Conserto3 is H100. All three share the total of 8 local slots. Dispatch is round-robin.
All endpoints must serve the requested model and accept the configured local API key.
Unavailable nodes fail the request rather than spilling private content onto a public API.
Without this setting, only loopback Aurora port 8000 is used.

## Waiting and operations

Requests remain pending in memory until a slot opens. Client disconnects remove queued
requests and abort active upstream fetches. Client timeouts must allow the intended queue
wait. The authenticated `GET /status` returns active counts, queue length, caps, and nodes;
AdminBot's existing `/ops/llm-load` reports the same shared status when configured.
A UI can poll that endpoint while showing its request as pending; per-request queue
positions are not exposed.

Graceful shutdown cancels pending and active work. A process restart drops queued requests;
clients receive a connection failure and may retry. This is not a durable job queue. Do not
restart into new work until old provider generations have stopped: transport cancellation
cannot prove an upstream GPU has stopped computing. Likewise, run one gateway, not several
replicas, and make all participating services reachable through that one host (SSH tunnels
for applications on another host).

Validation in this repository uses synthetic HTTP clients and mocked model responses.
GPU availability and PaperMentor deployment must be checked on the actual hosts.
