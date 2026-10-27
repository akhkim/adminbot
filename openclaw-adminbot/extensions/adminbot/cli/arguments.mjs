import { parseArgs } from "node:util";
import { ApiError, bodyFields, requestSchema, resolveSchema, suggest } from "./client.mjs";

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
    throw new ApiError(
      "INVALID_INPUT",
      `--set ${path}: field paths are dot-separated names like a.b.c, with no empty or reserved parts`,
    );
  }
  for (const key of keys.slice(0, -1)) {
    if (
      cursor[key] !== undefined &&
      (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key]))
    ) {
      throw new ApiError(
        "INVALID_INPUT",
        `--set ${path}: ${key} is already set to a non-object value, so it cannot hold nested fields`,
      );
    }
    cursor = cursor[key] ??= {};
  }
  const key = keys.at(-1);
  if (Object.hasOwn(cursor, key)) {
    throw new ApiError(
      "INVALID_INPUT",
      `Duplicate body field: ${path} is given twice; pass each field once`,
    );
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
  const usage = `adminbot call ${operation.operationId} --help`;
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: model.options });
  } catch (error) {
    // Node names the offending option ("Unknown option '--foo'", "Option '--note <value>'
    // argument missing"); keep its first sentence and add the nearest real flags.
    const reason = String(error?.message ?? "invalid flags").split(/\. /u)[0];
    const flag = /'(--?[^' ]+)/u.exec(reason)?.[1]?.replace(/^-+/u, "");
    const flags = Object.keys(model.options).filter((name) => name !== "help");
    const suggestions =
      flag && reason.startsWith("Unknown option")
        ? suggest(flag, flags).map((name) => `--${name}`)
        : [];
    throw new ApiError(
      "INVALID_ARGUMENTS",
      `${reason}${suggestions.length ? `. Did you mean ${suggestions.join(" or ")}?` : ""}`,
      undefined,
      { hint: usage, details: { suggestions, valid_flags: flags.map((name) => `--${name}`) } },
    );
  }
  const { values, positionals } = parsed;
  const path = {},
    query = {},
    header = {},
    body = {};
  const pathParameters = (operation.parameters ?? []).filter(
    (parameter) => parameter.in === "path",
  );
  const idUsage = pathParameters.map((parameter) => `<${parameter.name}>`).join(" ");
  if (positionals.length > pathParameters.length) {
    throw new ApiError(
      "INVALID_ARGUMENTS",
      `Got ${positionals.length} positional values but this command takes ${pathParameters.length}${idUsage ? ` (${idUsage})` : ""}; quote values with spaces and pass text through a --flag`,
      undefined,
      { hint: usage, details: { unexpected: positionals.slice(pathParameters.length) } },
    );
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
      throw new ApiError(
        "INVALID_ARGUMENTS",
        `${binding.field} is given twice (as a positional ID and --${flag}, or twice as a flag); pass it once`,
      );
    }
    let converted;
    try {
      converted = binding.negative ? false : coerce(value, binding.schema);
    } catch {
      throw new ApiError(
        "INVALID_INPUT",
        `--${flag}: a value starting with "[" must be a JSON array, e.g. --${flag} '["a","b"]', or repeat the flag once per item`,
      );
    }
    target[binding.field] = converted;
    if (binding.location === "body") {
      bodyFlags = true;
    }
  }
  const missing = pathParameters
    .map((parameter) => parameter.name)
    .filter((name) => path[name] === undefined);
  if (missing.length) {
    throw new ApiError(
      "INVALID_ARGUMENTS",
      `Missing ${missing.join(", ")}: usage is adminbot call ${operation.operationId} ${idUsage}. Find IDs with a list command first.`,
      undefined,
      { hint: usage, details: { missing } },
    );
  }
  for (const field of values.set ?? []) {
    const split = field.indexOf("=");
    if (split < 1) {
      throw new ApiError(
        "INVALID_INPUT",
        `--set ${field}: expected FIELD=VALUE, e.g. --set profile.name="Ada" (VALUE is parsed as JSON when it can be)`,
      );
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
      throw new ApiError(
        "INVALID_INPUT",
        `--query ${split < 1 ? "value" : key}: expected a unique NAME=VALUE, e.g. --query limit=20`,
      );
    }
    query[key] = entry.slice(split + 1);
  }
  if (values.file && bodyFlags) {
    throw new ApiError(
      "INVALID_ARGUMENTS",
      "--file supplies the whole request body, so body flags cannot be added to it; put every field in the file, or drop --file",
    );
  }
  if (!operation.requestBody && (values.file || bodyFlags)) {
    throw new ApiError(
      "INVALID_ARGUMENTS",
      `${operation.operationId} (${operation.method.toUpperCase()} ${operation.path}) takes no request body; drop --file/--set`,
      undefined,
      { hint: usage },
    );
  }
  if (values.live && !Object.hasOwn(bodyFields(operation), "dry_run")) {
    throw new ApiError(
      "INVALID_ARGUMENTS",
      ["get", "head"].includes(operation.method)
        ? `${operation.operationId} only reads, so --live does not apply; drop it`
        : `${operation.operationId} has no dry run, so --live does not apply: it acts as soon as it runs. Drop --live, and confirm with the user before running it.`,
    );
  }
  return { ...parsed, path, query, header, body };
}
