import { readFileSync } from "node:fs";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import createClient from "openapi-fetch";

export const document = JSON.parse(
  readFileSync(new URL("./openapi.generated.json", import.meta.url), "utf8"),
);
export const operations = Object.fromEntries(
  Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ["get", "post", "put", "patch", "delete", "head"].includes(method))
      .map(([method, operation]) => [operation.operationId, { ...operation, path, method }]),
  ),
);

/**
 * Every failure the CLI reports. `hint` is the next command to run, `retryable` says whether the
 * same call may simply be repeated, and `details` carries structured facts (valid values, the
 * server's own error code, suggestions) for an agent to act on without parsing prose.
 */
export class ApiError extends Error {
  constructor(code, message, status, { hint, retryable, details } = {}) {
    super(message);
    Object.assign(this, { code, status, hint, retryable, details });
  }
}

/** Up to `limit` candidates closest to `input`: substring matches first, then by edit distance. */
export function suggest(input, candidates, limit = 3) {
  const needle = String(input ?? "").toLowerCase();
  if (!needle) {
    return [];
  }
  const distance = (a, b) => {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      previous = current;
    }
    return previous[b.length];
  };
  return [...new Set(candidates)]
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const contains = lower.includes(needle) || needle.includes(lower);
      return { candidate, score: contains ? 0 : distance(needle, lower) };
    })
    .filter(({ score }) => score <= Math.max(2, Math.floor(needle.length / 3)))
    .toSorted((a, b) => a.score - b.score || a.candidate.length - b.candidate.length)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}
export function serviceOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(
      "INVALID_URL",
      "The service URL (--url or ADMINBOT_URL) is not a URL; expected an origin such as https://admin.safe.eu",
      undefined,
      { hint: `adminbot whoami --url ${document.servers[0].url}` },
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      "INVALID_URL",
      `The service URL must be a bare HTTPS origin (or http:// on localhost) with no path, query or credentials; got ${url.protocol}//${url.host}${url.pathname === "/" ? "" : " with a path"}`,
      undefined,
      {
        hint: `adminbot whoami --url ${url.protocol === "https:" || url.protocol === "http:" ? url.origin : document.servers[0].url}`,
      },
    );
  }
  return url.origin;
}
export function resolveSchema(schema = {}) {
  return schema.$ref ? document.components.schemas[schema.$ref.split("/").at(-1)] : schema;
}
export function requestSchema(operation) {
  return resolveSchema(operation.requestBody?.content?.["application/json"]?.schema);
}
export function bodyFields(operation) {
  const collect = (inputSchema) => {
    const schema = resolveSchema(inputSchema);
    return Object.assign(
      {},
      ...(schema.anyOf ?? schema.oneOf ?? schema.allOf ?? []).map(collect),
      schema.properties ?? {},
    );
  };
  return collect(requestSchema(operation));
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map();
export function validate(schema, value, label = "input") {
  if (!validators.has(schema)) {
    validators.set(schema, ajv.compile({ ...schema, components: document.components }));
  }
  const validator = validators.get(schema);
  if (!validator(value)) {
    // Ajv's error text names fields and constraints, never the input values.
    throw new ApiError(
      "INVALID_INPUT",
      `${label} does not match the API contract: ${ajv.errorsText(validator.errors, { dataVar: label })}`,
      undefined,
      {
        details: {
          problems: validator.errors.map(({ instancePath, message, params }) => {
            const problem = {
              field: `${label}${instancePath.replaceAll("/", ".")}`,
              problem: message,
            };
            if (params?.allowedValues) {
              problem.allowed = params.allowedValues;
            }
            if (params?.missingProperty) {
              problem.missing = params.missingProperty;
            }
            if (params?.additionalProperty) {
              problem.unexpected = params.additionalProperty;
            }
            return problem;
          }),
        },
      },
    );
  }
}

/** Typed for SDK consumers by client.d.ts and the generated OpenAPI declarations. */
export function createAdminBotClient(options = {}) {
  return createClient({
    ...options,
    baseUrl: serviceOrigin(options.baseUrl ?? document.servers[0].url),
    redirect: "error",
  });
}

/** The service's `{ error: { code, message } }`, when it sent one. */
function serverReason(raw) {
  try {
    const text =
      Buffer.isBuffer(raw) || raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : raw;
    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    const message = parsed?.error?.message ?? parsed?.message;
    const code = parsed?.error?.code ?? parsed?.code;
    return {
      message: typeof message === "string" && message.trim() ? message.trim() : undefined,
      code: typeof code === "string" ? code : undefined,
    };
  } catch {
    return {};
  }
}

// What an HTTP status means for whoever called the CLI, and what to do next.
const STATUS_GUIDE = {
  400: ["the input was rejected", "fix the input; see `adminbot schema OPERATION`", false],
  401: ["the token is missing, revoked or expired", "adminbot login", false],
  403: [
    "your account may not do this (role, ownership, or a step API tokens may never take: changing password or email, impersonating)",
    "adminbot whoami",
    false,
  ],
  404: [
    "the record does not exist (check the ID with a list command), or the server is older than this CLI",
    "adminbot operations",
    false,
  ],
  405: [
    "the server does not accept this method here; it may be older than this CLI",
    undefined,
    false,
  ],
  409: [
    "the record changed or is in a state that forbids this; re-read it before deciding",
    undefined,
    false,
  ],
  413: ["the request is too large", undefined, false],
  415: ["the server expected JSON", undefined, false],
  422: ["the input was rejected", "fix the input; see `adminbot schema OPERATION`", false],
  429: ["too many requests (600 per minute per token)", undefined, true],
};

/**
 * A refusal, with the service's own reason first.
 *
 * Handlers answer `{ error: { message } }` naming what was wrong -- the missing field, the
 * permission, the policy -- and a caller (a person, or an agent correcting itself) needs that
 * sentence, not a generic one. Bounded so a misbehaving server cannot flood the terminal.
 */
function serviceError(operation, response, raw) {
  const { status } = response;
  const reason = serverReason(raw);
  const method = operation.method.toUpperCase();
  const read = method === "GET" || method === "HEAD";
  const [meaning, rawHint, guideRetryable] =
    STATUS_GUIDE[status] ??
    (status >= 500
      ? [
          read
            ? "the server failed; reads are safe to repeat"
            : "the server failed; the change may or may not have been applied, so re-read before repeating it",
          undefined,
          read || [502, 503, 504].includes(status),
        ]
      : ["the request was refused", undefined, false]);
  const retryAfter = Number(response.headers.get("retry-after"));
  const hint = rawHint?.replace("OPERATION", operation.operationId);
  return new ApiError(
    "SERVICE_ERROR",
    reason.message
      ? `AdminBot rejected the request: ${reason.message.slice(0, 500)}`
      : `AdminBot rejected the request (HTTP ${status}); check permissions, policy, and input`,
    status,
    {
      hint:
        status === 429 && retryAfter > 0
          ? `wait ${retryAfter}s, then repeat the same command`
          : hint,
      retryable: guideRetryable,
      details: {
        request: `${method} ${operation.path}`,
        meaning,
        ...(reason.code ? { server_code: reason.code } : {}),
        ...(retryAfter > 0 ? { retry_after_seconds: retryAfter } : {}),
        ...(!read && status >= 500 ? { may_have_applied: true } : {}),
      },
    },
  );
}

/** Why fetch failed, from the error undici throws (its `cause` holds the system error). */
function connectionError(error, operation, origin, timeout) {
  const read = ["get", "head"].includes(operation.method);
  const cause = error?.cause ?? {};
  const code = cause.code ?? error?.code;
  const unsure = read
    ? {}
    : { may_have_applied: true, note: "re-read the record before repeating a write" };
  const base = { request: `${operation.method.toUpperCase()} ${operation.path}`, origin };
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new ApiError(
      "CONNECTION_ERROR",
      `No answer from ${origin} within ${timeout} ms`,
      undefined,
      {
        hint: read
          ? `repeat with --timeout ${Math.min(timeout * 4, 300000)}`
          : "re-read the record, then decide whether to repeat",
        retryable: read,
        details: { ...base, reason: "TIMEOUT", timeout_ms: timeout, ...unsure },
      },
    );
  }
  const text = `${error?.message ?? ""} ${cause.message ?? ""}`;
  const [kind, why, hint] = /redirect/iu.test(text)
    ? [
        "REDIRECTED",
        `${origin} answered with a redirect, which the CLI never follows (credentials stay on the origin you named)`,
        "use the final origin with --url, e.g. https://admin.safe.eu",
      ]
    : code === "ENOTFOUND" || code === "EAI_AGAIN"
      ? ["DNS_ERROR", `Cannot resolve the host of ${origin}`, "check the URL and your network/VPN"]
      : code === "ECONNREFUSED"
        ? [
            "CONNECTION_REFUSED",
            `Nothing is listening at ${origin}`,
            "check --url / ADMINBOT_URL and that the service is up",
          ]
        : /CERT|SSL|TLS/iu.test(`${code} ${text}`)
          ? [
              "TLS_ERROR",
              `The TLS certificate of ${origin} was not accepted (${code ?? "TLS failure"})`,
              "check the URL; a proxy may be intercepting HTTPS",
            ]
          : [
              "CONNECTION_ERROR",
              `Cannot reach ${origin}${code ? ` (${code})` : ""}: ${(cause.message ?? error?.message ?? "network failure").slice(0, 200)}`,
              "check the network, then repeat",
            ];
  return new ApiError("CONNECTION_ERROR", why, undefined, {
    hint,
    retryable: kind !== "REDIRECTED" && kind !== "TLS_ERROR" && read,
    details: { ...base, reason: kind, ...(code ? { system_code: code } : {}), ...unsure },
  });
}

export async function callOperation(
  operationId,
  {
    baseUrl,
    token,
    path = {},
    query = {},
    header = {},
    body,
    timeout = 30000,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const operation = operations[operationId];
  if (!operation) {
    const suggestions = suggest(operationId, Object.keys(operations));
    throw new ApiError("UNKNOWN_OPERATION", `Unknown operation: ${operationId}`, undefined, {
      hint: suggestions[0] ? `adminbot call ${suggestions[0]} --help` : "adminbot operations",
      details: { suggestions },
    });
  }
  for (const parameter of operation.parameters ?? []) {
    const value = { path, header, query }[parameter.in]?.[parameter.name];
    if (value === undefined && parameter.required) {
      throw new ApiError(
        "INVALID_INPUT",
        `Missing required ${parameter.in} parameter: ${parameter.name}`,
        undefined,
        { hint: `adminbot call ${operationId} --help`, details: { missing: parameter.name } },
      );
    }
    if (value !== undefined) {
      validate(parameter.schema ?? {}, value, parameter.name);
      if (parameter.in === "path" && [".", ".."].includes(value)) {
        throw new ApiError(
          "INVALID_INPUT",
          `${parameter.name} cannot be "${value}"; pass the record's real ID`,
        );
      }
    }
  }
  if (operation.requestBody) {
    validate(requestSchema(operation), body ?? {}, "body");
  }
  const client = createAdminBotClient({ baseUrl, fetch: fetchImpl });
  const origin = serviceOrigin(baseUrl ?? document.servers[0].url);
  let result;
  try {
    result = await client[operation.method.toUpperCase()](operation.path, {
      params: { path, query },
      ...(operation.requestBody ? { body: body ?? {} } : {}),
      headers: {
        ...header,
        Accept: "application/json",
        ...(token && operation.security?.length !== 0 ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(timeout),
      parseAs: "arrayBuffer",
    });
  } catch (error) {
    throw connectionError(error, operation, origin, timeout);
  }
  const { response } = result;
  if (!response.ok) {
    throw serviceError(operation, response, result.error);
  }
  if (response.status === 204 || result.data === undefined) {
    return null;
  }
  const buffer = Buffer.from(result.data);
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new ApiError(
        "INVALID_RESPONSE",
        `${origin} said it sent JSON but the body is not valid JSON; a proxy, captive portal or a different service may be answering`,
        undefined,
        { hint: "check --url / ADMINBOT_URL", retryable: true },
      );
    }
  }
  if (type.startsWith("text/")) {
    return buffer.toString("utf8");
  }
  return buffer;
}
