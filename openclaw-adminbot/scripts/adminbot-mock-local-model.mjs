#!/usr/bin/env node
// Controllable mock vLLM for load, timeout, and recovery tests; no GPU required.
// node scripts/adminbot-mock-local-model.mjs --concurrency 2 --latency-ms 800
// See --help for failure modes and the control API.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

// vLLM's own default port, and the default half of ADMINBOT_LOCAL_BASE_URL in every caller.
const DEFAULT_PORT = 8000;
const DEFAULT_HOST = "127.0.0.1";

// `--max-num-seqs 2` on the live unit. See the file header.
const DEFAULT_CONCURRENCY = 2;

// The model id the callers send when ADMINBOT_LOCAL_MODEL is unset (DEFAULT_LOCAL_MODEL in
// extensions/adminbot/src/cv-scan.ts). Answering /v1/models with this name means a health check
// that greps for the configured model finds it without extra flags.
const DEFAULT_MODEL = "nvidia/Qwen3.5-122B-A10B-NVFP4";

// Long enough that a queue actually forms at the default concurrency, short enough that a
// hundred-request sweep finishes while someone is watching it. The real thing is seconds to tens
// of seconds per call; --latency-ms is how you ask for that.
const DEFAULT_LATENCY_MS = 600;

const FAIL_MODES = new Set(["none", "503", "hang", "refuse", "500", "econnreset"]);

function usage() {
  return `Mock local-inference server -- impersonates vLLM's OpenAI-compatible API.

  node scripts/adminbot-mock-local-model.mjs [options]

Serving
  --port <n>              Listen port. Default ${DEFAULT_PORT}.
  --host <addr>           Bind address. Default ${DEFAULT_HOST}.
  --allow-remote          Permit a non-loopback --host. Off by default; see the file header.
  --model <id>            Model id reported by /v1/models. Default ${DEFAULT_MODEL}.
  --api-key <key>         Expect this bearer token.
  --require-api-key       Reject requests whose bearer token does not match --api-key with 401.

Load shape
  --concurrency <n>       Requests served at once. Default ${DEFAULT_CONCURRENCY} (vLLM --max-num-seqs 2).
  --queue-limit <n>       Queued requests tolerated beyond those. Default unbounded, which is what
                          vLLM does. Set it to shed load with 503 instead, which is the behaviour a
                          fallback path should be tested against.
  --latency-ms <n>        Service time once admitted. Default ${DEFAULT_LATENCY_MS}.
  --jitter-ms <n>         Uniform +/- jitter on that. Default 0, so a run is reproducible.
  --ttft-ms <n>           Time to first streamed chunk. Default: a quarter of --latency-ms.

Failure injection
  --fail-mode <mode>      none | 503 | 500 | hang | econnreset | refuse. Default none.
                          hang accepts the request and never answers (tests client timeouts).
                          econnreset answers by destroying the socket mid-flight.
                          refuse closes the listener, so connections get ECONNREFUSED -- this is
                          "the local server is not running", which is a different failure from 503
                          and should exercise a different branch.
  --fail-rate <0..1>      Fraction of requests the mode applies to. Default 1.
  --fail-after <n>        Serve this many requests normally first. Default 0.

Observability
  --log <file>            Append one NDJSON line per request. Default: stdout summary only.
  --quiet                 No per-request stdout line.
  --seed <n>              Seed for generated reply text. Default 1.

Control plane (so a load test can change the weather mid-run, without a restart)
  --control-port <n>      Its own listener, so --fail-mode refuse stays reversible. Default port+1.
  GET  /__stats           Counters, in-flight, peak arrival concurrency, duplicate fingerprints.
  GET  /__requests        The recorded request log.
  POST /__control         JSON patch over any of: concurrency, queueLimit, latencyMs, jitterMs,
                          ttftMs, failMode, failRate, failAfter.
  POST /__reset           Clear counters and the request log.
`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const flag = (name) => args.includes(`--${name}`);
  const value = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) {
      return fallback;
    }
    const raw = args[at + 1];
    if (raw === undefined || raw.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    return raw;
  };
  const number = (name, fallback) => {
    const raw = value(name, undefined);
    if (raw === undefined) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`--${name} must be a number, got ${raw}`);
    }
    return parsed;
  };

  const latencyMs = Math.max(0, number("latency-ms", DEFAULT_LATENCY_MS));
  const failMode = String(value("fail-mode", "none"));
  if (!FAIL_MODES.has(failMode)) {
    throw new Error(`--fail-mode must be one of ${[...FAIL_MODES].join(", ")}, got ${failMode}`);
  }
  return {
    port: number("port", Number(process.env.ADMINBOT_MOCK_MODEL_PORT ?? DEFAULT_PORT)),
    controlPort: number("control-port", number("port", DEFAULT_PORT) + 1),
    host: String(value("host", DEFAULT_HOST)),
    allowRemote: flag("allow-remote"),
    model: String(value("model", process.env.ADMINBOT_LOCAL_MODEL ?? DEFAULT_MODEL)),
    apiKey: value("api-key", process.env.VLLM_API_KEY ?? "vllm-local"),
    requireApiKey: flag("require-api-key"),
    concurrency: Math.max(1, number("concurrency", DEFAULT_CONCURRENCY)),
    // Infinity, not a large number: vLLM queues without bound, and a mock that silently shed at
    // 10_000 would make an unbounded-queue bug look like a working load-shedder.
    queueLimit: number("queue-limit", Number.POSITIVE_INFINITY),
    latencyMs,
    jitterMs: Math.max(0, number("jitter-ms", 0)),
    ttftMs: Math.max(0, number("ttft-ms", Math.round(latencyMs / 4))),
    failMode,
    failRate: Math.min(1, Math.max(0, number("fail-rate", 1))),
    failAfter: Math.max(0, number("fail-after", 0)),
    logFile: value("log", undefined),
    quiet: flag("quiet"),
    seed: number("seed", 1),
  };
}

const options = parseArgs(process.argv);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
if (!options.allowRemote && !LOOPBACK_HOSTS.has(options.host)) {
  console.error(
    `refusing to bind ${options.host}: every AdminBot caller asserts this endpoint is loopback ` +
      `before it sends anything, so a remote bind serves nobody and exposes a model endpoint. ` +
      `Pass --allow-remote if you really mean it.`,
  );
  process.exit(1);
}

/** Shared control settings and counters. peakArrivals includes queued requests; peakServed is capped by the mock and cannot validate client admission. */
const state = {
  concurrency: options.concurrency,
  queueLimit: options.queueLimit,
  latencyMs: options.latencyMs,
  jitterMs: options.jitterMs,
  ttftMs: options.ttftMs,
  failMode: options.failMode,
  failRate: options.failRate,
  failAfter: options.failAfter,

  arrivals: 0,
  served: 0,
  shed503: 0,
  failed: 0,
  hung: 0,
  rejectedAuth: 0,
  inFlightArrivals: 0,
  peakArrivals: 0,
  inFlightServed: 0,
  peakServed: 0,
  queueDepth: 0,
  peakQueueDepth: 0,

  /** fingerprint -> times seen. A duplicate is a retry, a replay, or a missing idempotency guard. */
  fingerprints: new Map(),
  /** One entry per request, in arrival order. Capped so a long soak does not eat the heap. */
  log: [],
  /** Sockets parked by --fail-mode hang, kept so shutdown can close them. */
  hanging: new Set(),
};

const MAX_LOG_ENTRIES = 50_000;
const logStream = options.logFile
  ? fs.createWriteStream(options.logFile, { flags: "a" })
  : undefined;

/**
 * Deterministic PRNG (mulberry32), so `--seed 7` twice is the same run twice.
 *
 * Math.random would make --fail-rate 0.3 a different set of victims on every run, and a load test
 * whose failures move cannot be bisected against a fix.
 */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = makeRandom(options.seed);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * What makes two requests "the same request".
 *
 * Deliberately the semantic payload -- model plus messages plus the decoding knobs -- and not the
 * raw bytes: a retry that re-serializes the same object with keys in a different order is still a
 * duplicate, and a test asserting "the queue did not send this prompt twice" wants that to count.
 */
function fingerprintOf(route, body) {
  const material = JSON.stringify({
    route,
    model: body?.model ?? null,
    messages: body?.messages ?? null,
    input: body?.input ?? null,
    temperature: body?.temperature ?? null,
    max_tokens: body?.max_tokens ?? null,
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      // Reimbursement calls carry base64 receipt images, so the ceiling has to be generous; it
      // exists only so a runaway client cannot exhaust memory here.
      if (bytes > 64 * 1024 * 1024) {
        reject(new Error("request body over 64 MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * An OpenAI-shaped error envelope, because that is what the callers' error paths were written
 * against. A bare `{"error":"busy"}` would be reported by the client as malformed JSON rather than
 * as the 503 it is, which sends whoever is debugging to the wrong layer.
 */
function sendError(response, status, message, type) {
  sendJson(response, status, {
    error: { message, type, param: null, code: status === 503 ? "server_overloaded" : null },
  });
}

/** One error, as a message, however it was thrown. */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function recordRequest(entry) {
  state.log.push(entry);
  if (state.log.length > MAX_LOG_ENTRIES) {
    state.log.shift();
  }
  logStream?.write(`${JSON.stringify(entry)}\n`);
  if (!options.quiet) {
    console.log(
      `[${entry.received_at}] ${entry.route} fp=${entry.fingerprint} seen=${entry.fingerprint_seen}` +
        ` arrivals_in_flight=${entry.arrivals_in_flight} queue=${entry.queue_depth}` +
        ` -> ${entry.outcome}${entry.status ? ` ${entry.status}` : ""}`,
    );
  }
}

/**
 * Which failure, if any, this request gets.
 *
 * Sampled once per request and before the queue, not after: a server that is refusing connections
 * is refusing them whether or not it has a free slot, and deciding after the wait would make every
 * injected 503 arrive late, which is the one thing a load-shedding test must not have to assume.
 */
function chooseFailure() {
  if (state.failMode === "none" || state.arrivals <= state.failAfter) {
    return "none";
  }
  return random() < state.failRate ? state.failMode : "none";
}

/**
 * Builds a value that satisfies a JSON-schema subset, for callers that send `response_format`.
 *
 * workshop-match-llm.ts sends a strict json_schema and parses the reply against it; a mock that
 * answered with prose would fail that caller at the parse rather than at the queue, and the test
 * would be measuring the wrong thing. Only the constructs the callers in this tree actually use
 * are handled -- object, array, string, integer/number, boolean -- and anything else becomes null,
 * which is visible rather than silently plausible.
 */
function instanceOfSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 8) {
    return null;
  }
  switch (schema.type) {
    case "object": {
      const out = {};
      const properties = schema.properties ?? {};
      // Required first, then the rest: a strict schema rejects a missing required key, and an
      // extra optional one is harmless.
      const keys = new Set([...(schema.required ?? []), ...Object.keys(properties)]);
      for (const key of keys) {
        out[key] = instanceOfSchema(properties[key], depth + 1);
      }
      return out;
    }
    // Empty: "the model found no matches" is a legitimate answer to every schema'd call in this
    // tree, and inventing entries would put fabricated paper ids into a test's assertions.
    case "array":
      return [];
    case "string":
      return "mock";
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

/**
 * The assistant text for one chat completion.
 *
 * Derived from the fingerprint so the same prompt always gets the same answer: a load test that
 * replays a request and compares outputs is testing its own queue, not the mock's mood.
 */
function completionContent(body, fingerprint) {
  const schema = body?.response_format?.json_schema?.schema;
  if (schema) {
    return JSON.stringify(instanceOfSchema(schema));
  }
  if (body?.response_format?.type === "json_object") {
    return JSON.stringify({ mock: true, fingerprint });
  }
  return `Mock local model reply (fingerprint ${fingerprint}). No real inference ran.`;
}

function completionEnvelope(model, fingerprint, content) {
  return {
    id: `chatcmpl-mock-${fingerprint}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        logprobs: null,
        // Never "length": cv-scan.ts turns that into a specific, wrong diagnosis ("a reasoning
        // model whose thinking is not disabled"), and a mock should not hand a debugger a lead
        // that is false by construction.
        finish_reason: "stop",
      },
    ],
    // Characters, not tokens, and deliberately not dressed up as a tokenizer's output. Nothing in
    // this tree reads `usage`; if something starts to, it needs a real server's numbers, not a
    // plausible-looking guess from a mock.
    usage: {
      prompt_tokens: 0,
      completion_tokens: content.length,
      total_tokens: content.length,
    },
  };
}

/**
 * A deterministic unit-ish vector, for /v1/embeddings.
 *
 * guidebook/local-client.ts normalizes whatever comes back and rejects non-numeric entries, so the
 * only contract that matters here is "the right number of numeric vectors, same input same vector".
 */
function embeddingFor(text, dimensions) {
  const digest = crypto.createHash("sha256").update(text).digest();
  const out = Array.from(
    { length: dimensions },
    (_unused, index) => (digest[index % digest.length] - 128) / 128,
  );
  return out;
}

async function streamCompletion(response, model, fingerprint, content) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta, finish) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-mock-${fingerprint}`,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })}\n\n`;
  response.write(frame({ role: "assistant", content: "" }));
  // Chunked by words rather than one blob, because a client that measures time-to-first-token or
  // renders progressively would see nothing to measure otherwise.
  const pieces = content.match(/\S+\s*/gu) ?? [content];
  const perPiece =
    pieces.length > 0 ? Math.max(0, state.latencyMs - state.ttftMs) / pieces.length : 0;
  for (const piece of pieces) {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    response.write(frame({ content: piece }));
    await sleep(perPiece);
  }
  response.write(frame({}, "stop"));
  response.write("data: [DONE]\n\n");
  response.end();
}

/**
 * The admission gate.
 *
 * Waits for a free slot the way vLLM does -- queued, not rejected -- unless --queue-limit says the
 * server sheds instead. Returns a release function, or null when the request was shed.
 */
const waiters = [];

/** Release each permit once: abort, socket close, and completion can overlap. */
function makeRelease() {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.inFlightServed -= 1;
    // Only when a slot is genuinely free: --concurrency can be lowered at runtime through
    // /__control, and waking a waiter into a now-oversubscribed server would quietly exceed the
    // limit the test just asked for.
    if (waiters.length > 0 && state.inFlightServed < state.concurrency) {
      waiters.shift()();
    }
  };
}

function admit() {
  state.inFlightServed += 1;
  state.peakServed = Math.max(state.peakServed, state.inFlightServed);
  return makeRelease();
}

function acquireSlot() {
  if (state.inFlightServed < state.concurrency) {
    return Promise.resolve(admit());
  }
  if (state.queueDepth >= state.queueLimit) {
    return Promise.resolve(null);
  }
  state.queueDepth += 1;
  state.peakQueueDepth = Math.max(state.peakQueueDepth, state.queueDepth);
  return new Promise((resolve) => {
    waiters.push(() => {
      state.queueDepth -= 1;
      resolve(admit());
    });
  });
}

function serviceTime() {
  if (state.jitterMs === 0) {
    return state.latencyMs;
  }
  return Math.max(0, state.latencyMs + (random() * 2 - 1) * state.jitterMs);
}

function statsSnapshot() {
  const duplicates = [...state.fingerprints.entries()]
    .filter(([, count]) => count > 1)
    .map(([fingerprint, count]) => ({ fingerprint, count }))
    .toSorted((left, right) => right.count - left.count);
  return {
    config: {
      model: options.model,
      concurrency: state.concurrency,
      queue_limit: Number.isFinite(state.queueLimit) ? state.queueLimit : null,
      latency_ms: state.latencyMs,
      jitter_ms: state.jitterMs,
      ttft_ms: state.ttftMs,
      fail_mode: state.failMode,
      fail_rate: state.failRate,
      fail_after: state.failAfter,
    },
    counters: {
      arrivals: state.arrivals,
      served: state.served,
      shed_503: state.shed503,
      failed: state.failed,
      hung: state.hung,
      rejected_auth: state.rejectedAuth,
    },
    concurrency: {
      // The client's own in-flight count, seen from this end. This is the assertion a queue layer
      // should be tested against: peak_arrivals <= whatever limit the client claims to enforce.
      in_flight_arrivals: state.inFlightArrivals,
      peak_arrivals: state.peakArrivals,
      in_flight_served: state.inFlightServed,
      peak_served: state.peakServed,
      queue_depth: state.queueDepth,
      peak_queue_depth: state.peakQueueDepth,
    },
    distinct_fingerprints: state.fingerprints.size,
    duplicate_fingerprints: duplicates,
  };
}

function applyControl(patch) {
  const numeric = {
    concurrency: (v) => Math.max(1, v),
    queueLimit: (v) => v,
    latencyMs: (v) => Math.max(0, v),
    jitterMs: (v) => Math.max(0, v),
    ttftMs: (v) => Math.max(0, v),
    failRate: (v) => Math.min(1, Math.max(0, v)),
    failAfter: (v) => Math.max(0, v),
  };
  const applied = {};
  for (const [key, clamp] of Object.entries(numeric)) {
    if (patch[key] === undefined) {
      continue;
    }
    const parsed = patch[key] === null ? Number.POSITIVE_INFINITY : Number(patch[key]);
    if (!Number.isFinite(parsed) && key !== "queueLimit") {
      throw new Error(`${key} must be a number`);
    }
    state[key] = clamp(parsed);
    applied[key] = state[key];
  }
  if (patch.failMode !== undefined) {
    if (!FAIL_MODES.has(String(patch.failMode))) {
      throw new Error(`failMode must be one of ${[...FAIL_MODES].join(", ")}`);
    }
    state.failMode = String(patch.failMode);
    applied.failMode = state.failMode;
    // "refuse" is not a response, it is the absence of a listener, so flipping it has to move the
    // socket rather than set a flag the handler reads -- a handler only ever runs on a connection
    // that was accepted.
    setListening(state.failMode !== "refuse");
  }
  // Raising --concurrency should start work immediately rather than at the next completion.
  while (waiters.length > 0 && state.inFlightServed < state.concurrency) {
    waiters.shift()();
  }
  return applied;
}

let listening = false;
function setListening(shouldListen) {
  if (shouldListen === listening) {
    return;
  }
  if (shouldListen) {
    server.listen(options.port, options.host, () => {
      listening = true;
      console.log(`mock local model: listening again on http://${options.host}:${options.port}/v1`);
    });
    return;
  }
  // closeAllConnections as well as close(): close() alone stops *new* connections but leaves
  // keep-alive sockets usable, and undici reuses them -- so a client with a warm pool would keep
  // getting served by a server that is meant to be down.
  server.closeAllConnections?.();
  server.close(() => {
    listening = false;
    console.log("mock local model: listener closed -- connections will be refused");
  });
}

async function handleControlPlane(request, response, route) {
  if (route === "/__stats" && request.method === "GET") {
    sendJson(response, 200, statsSnapshot());
    return true;
  }
  if (route === "/__requests" && request.method === "GET") {
    sendJson(response, 200, { requests: state.log });
    return true;
  }
  if (route === "/__reset" && request.method === "POST") {
    state.arrivals = 0;
    state.served = 0;
    state.shed503 = 0;
    state.failed = 0;
    state.hung = 0;
    state.rejectedAuth = 0;
    state.peakArrivals = 0;
    state.peakServed = 0;
    state.peakQueueDepth = 0;
    state.fingerprints.clear();
    state.log.length = 0;
    sendJson(response, 200, { reset: true });
    return true;
  }
  if (route === "/__control" && request.method === "POST") {
    try {
      const raw = await readBody(request);
      const applied = applyControl(raw ? JSON.parse(raw) : {});
      sendJson(response, 200, { applied, config: statsSnapshot().config });
    } catch (error) {
      sendError(response, 400, describeError(error), "bad_request");
    }
    return true;
  }
  return false;
}

const server = http.createServer((request, response) => {
  void handle(request, response).catch(
    /** @param {unknown} error */ (error) => {
      if (!response.headersSent) {
        sendError(response, 500, describeError(error), "mock_error");
      } else {
        response.destroy();
      }
    },
  );
});

/** Use a separate control listener so refuse mode can close and reopen the model listener without losing counters. */
const controlServer = http.createServer((request, response) => {
  const route = new URL(request.url ?? "/", `http://${options.host}`).pathname;
  void handleControlPlane(request, response, route)
    .then((handled) => {
      if (!handled) {
        sendError(
          response,
          404,
          `control plane serves /__stats, /__requests, /__control, /__reset -- not ${route}`,
          "not_found",
        );
      }
    })
    .catch(
      /** @param {unknown} error */ (error) => {
        sendError(response, 500, describeError(error), "mock_error");
      },
    );
});

async function handle(request, response) {
  const route = new URL(request.url ?? "/", `http://${options.host}`).pathname;
  if (await handleControlPlane(request, response, route)) {
    return;
  }

  // Both spellings: ADMINBOT_LOCAL_BASE_URL carries the /v1, but a health check that appends its
  // own path, or a caller configured without it, should still find the endpoint rather than a 404
  // that reads like the server is broken.
  const normalized = route.replace(/^\/v1/u, "") || "/";

  if (normalized === "/models" && request.method === "GET") {
    sendJson(response, 200, {
      object: "list",
      data: [
        {
          id: options.model,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mock-vllm",
          root: options.model,
          permission: [],
        },
      ],
    });
    return;
  }

  const isChat = normalized === "/chat/completions" && request.method === "POST";
  const isEmbeddings = normalized === "/embeddings" && request.method === "POST";
  if (!isChat && !isEmbeddings) {
    sendError(
      response,
      404,
      `mock local model has no route ${request.method} ${route}`,
      "not_found",
    );
    return;
  }

  const receivedAt = new Date().toISOString();
  const startedAt = Date.now();
  state.arrivals += 1;
  state.inFlightArrivals += 1;
  state.peakArrivals = Math.max(state.peakArrivals, state.inFlightArrivals);

  let entry;
  const finish = (outcome, status) => {
    state.inFlightArrivals -= 1;
    recordRequest({
      ...entry,
      outcome,
      status: status ?? null,
      duration_ms: Date.now() - startedAt,
    });
  };

  // Assigned in the try below, and every path that fails to assign it returns, so there is no
  // initializer here to be mistaken for a usable empty body.
  let body;
  try {
    const raw = await readBody(request);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    entry = baseEntry(request, normalized, {}, receivedAt, "unparseable");
    finish("bad_request", 400);
    sendError(response, 400, "mock local model could not parse the request body", "bad_request");
    return;
  }

  const fingerprint = fingerprintOf(normalized, body);
  const seen = (state.fingerprints.get(fingerprint) ?? 0) + 1;
  state.fingerprints.set(fingerprint, seen);
  entry = baseEntry(request, normalized, body, receivedAt, fingerprint);
  entry.fingerprint_seen = seen;

  if (options.requireApiKey) {
    const presented = /^Bearer\s+(.*)$/iu.exec(request.headers.authorization ?? "")?.[1]?.trim();
    if (presented !== options.apiKey) {
      state.rejectedAuth += 1;
      finish("rejected_auth", 401);
      sendError(response, 401, "mock local model rejected the bearer token", "invalid_api_key");
      return;
    }
  }

  const failure = chooseFailure();
  if (failure === "refuse") {
    // The listener is already closed when refuse is set through /__control; a request that got in
    // through a warm socket before that is answered the same way a dead server answers, which is
    // not at all.
    setListening(false);
    state.hung += 1;
    state.hanging.add(response);
    finish("refused_connection", null);
    return;
  }
  if (failure === "hang") {
    state.hung += 1;
    state.hanging.add(response);
    response.on("close", () => state.hanging.delete(response));
    finish("hang", null);
    return;
  }
  if (failure === "econnreset") {
    state.failed += 1;
    finish("econnreset", null);
    request.socket.destroy();
    return;
  }
  if (failure === "503" || failure === "500") {
    state.failed += 1;
    const status = Number(failure);
    finish("injected_failure", status);
    sendError(
      response,
      status,
      status === 503
        ? "mock local model is at capacity"
        : "mock local model hit an injected internal error",
      status === 503 ? "server_overloaded" : "internal_error",
    );
    return;
  }

  const slot = await acquireSlot();
  if (!slot) {
    // Queue full. This is the load-shed path, and it is deliberately a 503 with no body beyond the
    // error envelope: a client should back off on it, not parse it.
    state.shed503 += 1;
    finish("shed_queue_full", 503);
    sendError(response, 503, "mock local model queue is full", "server_overloaded");
    return;
  }

  try {
    if (isEmbeddings) {
      await sleep(serviceTime());
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      state.served += 1;
      finish("served", 200);
      sendJson(response, 200, {
        object: "list",
        model: body.model ?? options.model,
        data: inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: embeddingFor(String(input), 384),
        })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      });
      return;
    }

    const model = body.model ?? options.model;
    const content = completionContent(body, fingerprint);
    if (body.stream) {
      await sleep(state.ttftMs);
      state.served += 1;
      finish("served_stream", 200);
      await streamCompletion(response, model, fingerprint, content);
      return;
    }
    await sleep(serviceTime());
    state.served += 1;
    finish("served", 200);
    sendJson(response, 200, completionEnvelope(model, fingerprint, content));
  } finally {
    slot();
  }
}

/** Log a fingerprint for duplicate detection and a 120-character preview. Previews may contain prompt content; use synthetic inputs. */
function baseEntry(request, route, body, receivedAt, fingerprint) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.at(-1);
  const preview = typeof last?.content === "string" ? last.content.slice(0, 120) : null;
  return {
    received_at: receivedAt,
    route,
    method: request.method,
    fingerprint,
    fingerprint_seen: 1,
    model: body?.model ?? null,
    stream: Boolean(body?.stream),
    message_count: messages.length,
    max_tokens: body?.max_tokens ?? null,
    temperature: body?.temperature ?? null,
    has_response_format: Boolean(body?.response_format),
    // Surfaced because a queue or dedupe layer is very likely to add one, and if it does, a test
    // wants to see it arrive rather than infer it.
    idempotency_key: request.headers["idempotency-key"] ?? null,
    prompt_preview: preview,
    arrivals_in_flight: state.inFlightArrivals,
    queue_depth: state.queueDepth,
  };
}

server.on("error", (error) => {
  console.error(`mock local model listen failed: ${error.message}`);
  process.exit(1);
});

controlServer.on("error", (error) => {
  console.error(`mock local model control listen failed: ${error.message}`);
  process.exit(1);
});

server.listen(options.port, options.host, () => {
  listening = true;
  console.log(
    `mock local model: http://${options.host}:${options.port}/v1 ` +
      `(model ${options.model}, concurrency ${state.concurrency}, latency ${state.latencyMs}ms, ` +
      `fail-mode ${state.failMode})`,
  );
});

controlServer.listen(options.controlPort, options.host, () => {
  console.log(
    `  control: http://${options.host}:${options.controlPort}` +
      ` -- GET /__stats, GET /__requests, POST /__control, POST /__reset` +
      ` (also on :${options.port}, which --fail-mode refuse takes down).`,
  );
  console.log("  No production bundle, credential, or database is read by this script.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Parked responses would otherwise keep the process alive past the signal, which on a load
    // rig means an orphaned listener holding port 8000 against the next run.
    for (const response of state.hanging) {
      response.destroy();
    }
    state.hanging.clear();
    if (!options.quiet) {
      console.log(`\n${JSON.stringify(statsSnapshot(), null, 2)}`);
    }
    logStream?.end();
    server.closeAllConnections?.();
    controlServer.closeAllConnections?.();
    server.close();
    controlServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
