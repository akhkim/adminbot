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

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    Object.assign(this, { code, status });
  }
}
export function serviceOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError("INVALID_URL", "Invalid service URL");
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
      "Use an HTTPS origin or loopback HTTP origin without a path or embedded credentials",
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
      `${label}: ${ajv.errorsText(validator.errors, { dataVar: label })}`,
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

/**
 * The service's own reason for refusing, when it gave one.
 *
 * Handlers answer `{ error: { message } }` naming what was wrong -- the missing field, the
 * permission, the policy -- and a caller (a person, or an agent correcting itself) needs that
 * sentence, not a generic one. Bounded so a misbehaving server cannot flood the terminal.
 */
function rejectionMessage(raw) {
  let message;
  try {
    const text = Buffer.isBuffer(raw) || raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : raw;
    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    message = parsed?.error?.message ?? parsed?.message;
  } catch {
    message = undefined;
  }
  return typeof message === "string" && message.trim()
    ? `AdminBot rejected the request: ${message.trim().slice(0, 500)}`
    : "AdminBot rejected the request; check permissions, policy, and input";
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
    throw new ApiError("UNKNOWN_OPERATION", "Unknown operation; run adminbot operations");
  }
  for (const parameter of operation.parameters ?? []) {
    const value = { path, header, query }[parameter.in]?.[parameter.name];
    if (value === undefined && parameter.required) {
      throw new ApiError("INVALID_INPUT", `Missing ${parameter.in} parameter: ${parameter.name}`);
    }
    if (value !== undefined) {
      validate(parameter.schema ?? {}, value, parameter.name);
      if (parameter.in === "path" && [".", ".."].includes(value)) {
        throw new ApiError("INVALID_INPUT", "Path parameters cannot be dot segments");
      }
    }
  }
  if (operation.requestBody) {
    validate(requestSchema(operation), body ?? {}, "body");
  }
  const client = createAdminBotClient({ baseUrl, fetch: fetchImpl });
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
  } catch {
    throw new ApiError(
      "CONNECTION_ERROR",
      "Service unreachable, timed out, redirected, or returned an invalid response",
    );
  }
  const { response } = result;
  if (!response.ok) {
    throw new ApiError("SERVICE_ERROR", rejectionMessage(result.error), response.status);
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
      throw new ApiError("INVALID_RESPONSE", "Service returned invalid JSON");
    }
  }
  if (type.startsWith("text/")) {
    return buffer.toString("utf8");
  }
  return buffer;
}
