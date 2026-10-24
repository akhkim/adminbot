import { parseArgs } from "node:util";
import { ApiError, bodyFields, requestSchema, resolveSchema } from "./client.mjs";

export const dashed = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
const globalOptions = {
  url: { type: "string" },
  timeout: { type: "string" },
  file: { type: "string" },
  output: { type: "string" },
  set: { type: "string", multiple: true },
  query: { type: "string", multiple: true },
  live: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
};
export function commandWords(operation) {
  const words = operation.path.split("/").filter((part) => part && !part.startsWith("{"));
  const last = words.at(-1);
  if (
    operation.method === "post" &&
    [
      "approve",
      "reject",
      "run",
      "ask",
      "send",
      "login",
      "logout",
      "stop",
      "cancel",
      "remove",
      "invite",
      "withdraw",
      "clear",
    ].includes(last)
  ) {
    return words.join(" ");
  }
  const verb = {
    get: operation.path.endsWith("}") ? "get" : "list",
    post: "create",
    put: "update",
    patch: "update",
    delete: "delete",
    head: "head",
  }[operation.method];
  return [...words, verb].join(" ");
}
function jsonValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function coerce(value, inputSchema) {
  const schema = resolveSchema(inputSchema);
  if (schema.type === "array") {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) =>
      item.startsWith("[") ? JSON.parse(item) : [coerce(item, schema.items ?? {})],
    );
  }
  if (schema.type === "string") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  return jsonValue(value);
}
function assign(target, path, value) {
  let cursor = target;
  const keys = path.split(".");
  if (keys.some((key) => !key || ["__proto__", "prototype", "constructor"].includes(key))) {
    throw new ApiError("INVALID_INPUT", "Invalid body field path");
  }
  for (const key of keys.slice(0, -1)) {
    if (
      cursor[key] !== undefined &&
      (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key]))
    ) {
      throw new ApiError("INVALID_INPUT", "Overlapping body fields");
    }
    cursor = cursor[key] ??= {};
  }
  const key = keys.at(-1);
  if (Object.hasOwn(cursor, key)) {
    throw new ApiError("INVALID_INPUT", `Duplicate body field: ${path}`);
  }
  cursor[key] = value;
}

export function argumentModel(operation, alias = {}) {
  const options = { ...globalOptions };
  const bindings = {};
  const add = (rawFlag, binding) => {
    let flag = rawFlag;
    if (bindings[flag]) {
      throw new ApiError("CONTRACT_ERROR", `Ambiguous generated flag: ${flag}`);
    }
    if (options[flag]) {
      flag = `${binding.location}-${flag}`;
    }
    bindings[flag] = binding;
    const schema = resolveSchema(binding.schema);
    options[flag] = {
      type: schema.type === "boolean" ? "boolean" : "string",
      ...(schema.type === "array" ? { multiple: true } : {}),
    };
    if (schema.type === "boolean") {
      bindings[`no-${flag}`] = { ...binding, negative: true };
      options[`no-${flag}`] = { type: "boolean" };
    }
  };
  for (const parameter of operation.parameters ?? []) {
    add(dashed(parameter.name), {
      location: parameter.in,
      field: parameter.name,
      schema: parameter.schema ?? {},
      required: parameter.required,
    });
  }
  const body = requestSchema(operation);
  for (const [field, schema] of Object.entries(bodyFields(operation))) {
    // Secrets can be supplied via stdin/file; argv is visible to other processes.
    if (/password|token|secret/iu.test(field)) {
      continue;
    }
    const humanFlag = Object.entries(alias.flags ?? {}).find(([, name]) => name === field)?.[0];
    add(humanFlag ?? dashed(field), {
      location: "body",
      field,
      schema,
      required: body.required?.includes(field),
    });
  }
  if (alias.negativeFlags) {
    for (const [flag, field] of Object.entries(alias.negativeFlags)) {
      bindings[flag] = { location: "body", field, schema: { type: "boolean" }, negative: true };
      options[flag] = { type: "boolean" };
    }
  }
  if (operation.operationId === "post-auth-login") {
    options["password-stdin"] = { type: "boolean" };
  }
  return { options, bindings };
}

export function parseOperationArgs(operation, alias, argv) {
  const model = argumentModel(operation, alias);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: model.options });
  } catch {
    throw new ApiError("INVALID_ARGUMENTS", "Invalid flags or values; use this command's --help");
  }
  const { values, positionals } = parsed;
  const path = {},
    query = {},
    header = {},
    body = {};
  const pathParameters = (operation.parameters ?? []).filter(
    (parameter) => parameter.in === "path",
  );
  if (positionals.length > pathParameters.length) {
    throw new ApiError("INVALID_ARGUMENTS", "Too many positional IDs");
  }
  positionals.forEach((value, index) => {
    path[pathParameters[index].name] = value;
  });
  let bodyFlags = false;
  for (const [flag, value] of Object.entries(values)) {
    const binding = model.bindings[flag];
    if (!binding) {
      continue;
    }
    const target = { path, query, header, body }[binding.location];
    if (Object.hasOwn(target, binding.field)) {
      throw new ApiError("INVALID_ARGUMENTS", `Duplicate value for ${binding.field}`);
    }
    let converted;
    try {
      converted = binding.negative ? false : coerce(value, binding.schema);
    } catch {
      throw new ApiError("INVALID_INPUT", `Invalid JSON value for ${binding.field}`);
    }
    target[binding.field] = converted;
    if (binding.location === "body") {
      bodyFlags = true;
    }
  }
  for (const field of values.set ?? []) {
    const split = field.indexOf("=");
    if (split < 1) {
      throw new ApiError("INVALID_INPUT", "Use --set FIELD=VALUE");
    }
    assign(body, field.slice(0, split), jsonValue(field.slice(split + 1)));
    bodyFlags = true;
  }
  for (const entry of values.query ?? []) {
    const split = entry.indexOf("=");
    const key = entry.slice(0, split);
    if (
      split < 1 ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      Object.hasOwn(query, key)
    ) {
      throw new ApiError("INVALID_INPUT", "Use a unique --query NAME=VALUE");
    }
    query[key] = entry.slice(split + 1);
  }
  if (values.file && bodyFlags) {
    throw new ApiError("INVALID_ARGUMENTS", "Use input flags or --file without mixing them");
  }
  if (!operation.requestBody && (values.file || bodyFlags)) {
    throw new ApiError("INVALID_ARGUMENTS", "This operation does not accept a request body");
  }
  if (values.live && !Object.hasOwn(bodyFields(operation), "dry_run")) {
    throw new ApiError("INVALID_ARGUMENTS", "This operation has no dry-run control");
  }
  return { ...parsed, path, query, header, body };
}
