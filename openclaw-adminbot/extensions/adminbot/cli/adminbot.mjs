#!/usr/bin/env node
import { realpath, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { aliases } from "./aliases.mjs";
import { argumentModel, commandWords, parseOperationArgs } from "./arguments.mjs";
import { clearSession, forgetSavedSecret, saveSession, sessionToken } from "./auth.mjs";
import {
  ApiError,
  bodyFields,
  callOperation,
  document,
  operations,
  serviceOrigin,
} from "./client.mjs";
import { deviceLogin } from "./login.mjs";

const commandIndex = new Map();
for (const operation of Object.values(operations)) {
  const words = commandWords(operation);
  commandIndex.set(words, commandIndex.has(words) ? null : { operation: operation.operationId });
}
for (const [words, alias] of Object.entries(aliases)) {
  if (!operations[alias.operation]) {
    throw new Error(`Convenience alias references a missing OpenAPI operation: ${words}`);
  }
  commandIndex.set(words, alias);
}
const help = `AdminBot CLI — commands derived from OpenAPI (${Object.keys(operations).length} operations)

adminbot operations                          List API operations and generated commands
adminbot schema [OPERATION_ID]                Show OpenAPI, or one operation's contract
adminbot call OPERATION_ID [flags]            Call any documented operation
adminbot <generated command> [IDs] [flags]    Same API with readable command names
adminbot <command> --help                     Show generated parameters and flags

Examples:
  adminbot papers list
  adminbot work update PAPER_ID --note "Finished experiments"
  adminbot tasks update PAPER_ID fixes_merged --done
  adminbot papers progress PAPER_ID --step overleaf_writing
  adminbot auth login                         Sign in through the browser (API token)
  adminbot auth login --email EMAIL --password-stdin
  adminbot auth tokens list

Input fields become --kebab-case flags; arrays accept repeated flags.
Nested/dynamic fields: --set FIELD.PATH=VALUE; dynamic query: --query NAME=VALUE. Optional JSON: --file PATH or --file -.
Booleans: --done / --no-done. Dry-run operations need --live for real execution.
Global options: --url ORIGIN, --timeout MS, --output PATH, --json, --help.
Default: ${document.servers[0].url}; ADMINBOT_URL overrides it.
Auth: saved login (macOS Keychain where available) or ADMINBOT_TOKEN; never put secrets in argv.
Exit codes: 0 success, 1 service/network, 2 input, 3 auth/permission, 4 conflict.
`;
async function stdinText(stream) {
  if (stream.isTTY) {
    throw new ApiError("INPUT_REQUIRED", "Pipe input on stdin or use --file PATH");
  }
  let raw = "";
  for await (const chunk of stream) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) {
      throw new ApiError("INPUT_TOO_LARGE", "Input exceeds 1 MiB");
    }
  }
  return raw;
}
function operationHelp(operation, alias) {
  const model = argumentModel(operation, alias);
  return `${operation.operationId}: ${operation.summary}\n${(operation.parameters ?? [])
    .filter((parameter) => parameter.in === "path")
    .map((parameter) => `<${parameter.name}>`)
    .join(" ")}\n${Object.entries(model.bindings)
    .map(
      ([flag, field]) =>
        `  --${flag}  ${field.location}.${field.field}${field.required ? " (required)" : ""}${field.schema.enum ? `: ${field.schema.enum.join(", ")}` : ""}`,
    )
    .join("\n")}\nUse --file PATH or --set FIELD=VALUE for nested fields.\n`;
}
function findCommand(argv) {
  if (argv[0] === "call") {
    if (!operations[argv[1]]) {
      throw new ApiError("UNKNOWN_OPERATION", "Unknown operation; run adminbot operations");
    }
    return { alias: { operation: argv[1] }, args: argv.slice(2) };
  }
  for (let length = argv.length; length > 0; length--) {
    const alias = commandIndex.get(argv.slice(0, length).join(" "));
    if (alias) {
      return { alias, args: argv.slice(length) };
    }
  }
  throw new ApiError("UNKNOWN_COMMAND", "Unknown command; run adminbot operations");
}

const LOGIN_USAGE =
  "Usage: adminbot auth login [--name NAME] [--days 1-90] [--no-browser] [--url ORIGIN] [--timeout MS]";

/** `auth login` without --email or --file: the browser handshake that issues a personal API token. */
function deviceLoginArgs(argv) {
  if (argv[0] !== "auth" || argv[1] !== "login") {
    return undefined;
  }
  const args = argv.slice(2);
  if (args.some((arg) => ["--email", "--file", "--password-stdin", "--help", "-h"].includes(arg.split("=")[0]))) {
    return undefined;
  }
  const options = { browser: true };
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split(/[=](.*)/su);
    if (flag === "--no-browser" && inline === undefined) {
      options.browser = false;
      continue;
    }
    if (!["--name", "--days", "--url", "--timeout"].includes(flag)) {
      throw new ApiError("INVALID_ARGUMENTS", LOGIN_USAGE);
    }
    const value = inline ?? args[++index];
    if (value === undefined) {
      throw new ApiError("INVALID_ARGUMENTS", LOGIN_USAGE);
    }
    options[flag.slice(2)] = value;
  }
  if (options.days !== undefined) {
    options.days = Number(options.days);
    if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 90) {
      throw new ApiError("INVALID_ARGUMENTS", "--days must be 1–90");
    }
  }
  return options;
}
function requestTimeout(value) {
  const timeout = Number(value ?? 30000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) {
    throw new ApiError("INVALID_ARGUMENTS", "--timeout must be 1–300000 milliseconds");
  }
  return timeout;
}
// A token pasted into a flag or echoed back by a proxy must not reach a terminal log or an agent
// transcript through an error message.
const redact = (text) => text.replace(/abt_[A-Za-z0-9_-]{8,}/gu, "abt_[REDACTED]");

export async function run(
  argv,
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  try {
    if (!argv.length || ["--help", "-h"].includes(argv[0])) {
      stdout.write(help);
      return 0;
    }
    if (argv[0] === "schema") {
      if (argv.length > 2 || (argv[1] && !operations[argv[1]])) {
        throw new ApiError("UNKNOWN_OPERATION", "Unknown operation");
      }
      stdout.write(
        `${JSON.stringify(argv[1] ? { ...operations[argv[1]], components: document.components } : document, null, 2)}\n`,
      );
      return 0;
    }
    if (argv[0] === "operations") {
      if (argv.slice(1).some((arg) => arg !== "--json")) {
        throw new ApiError("INVALID_ARGUMENTS", "Usage: adminbot operations [--json]");
      }
      stdout.write(
        `${JSON.stringify(
          Object.values(operations).map((operation) => ({
            operationId: operation.operationId,
            command: commandWords(operation),
            method: operation.method.toUpperCase(),
            path: operation.path,
          })),
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    const credentials =
      env.ADMINBOT_CREDENTIALS_FILE ?? join(homedir(), ".config", "adminbot", "credentials.json");
    const browserLogin = deviceLoginArgs(argv);
    if (browserLogin) {
      const result = await deviceLogin({
        baseUrl: serviceOrigin(browserLogin.url ?? env.ADMINBOT_URL ?? document.servers[0].url),
        credentials,
        name: browserLogin.name,
        days: browserLogin.days,
        browser: browserLogin.browser,
        timeout: requestTimeout(browserLogin.timeout),
        env,
        stderr,
        fetchImpl,
      });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const { alias, args } = findCommand(argv);
    const operation = operations[alias.operation];
    if (args.includes("--help") || args.includes("-h")) {
      stdout.write(operationHelp(operation, alias));
      return 0;
    }
    const parsed = parseOperationArgs(operation, alias, args);
    const { values } = parsed;
    const baseUrl = serviceOrigin(values.url ?? env.ADMINBOT_URL ?? document.servers[0].url);
    const timeout = requestTimeout(values.timeout);
    let body = parsed.body;
    if (values.file) {
      try {
        body = JSON.parse(
          values.file === "-" ? await stdinText(stdin) : await readFile(values.file, "utf8"),
        );
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        throw new ApiError("INVALID_INPUT", "Cannot read JSON input");
      }
    }
    if (operation.requestBody && Object.hasOwn(bodyFields(operation), "dry_run")) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError("INVALID_INPUT", "Request body must be an object");
      }
      body = { ...body, dry_run: values.live !== true };
    }
    const login = operation.operationId === "post-auth-login";
    if (login && !values.file) {
      if (!values["password-stdin"] || !body.email?.trim()) {
        throw new ApiError("INPUT_REQUIRED", "Login requires --email ADDRESS --password-stdin");
      }
      body.password = (await stdinText(stdin)).replace(/\r?\n$/u, "");
      if (!body.password) {
        throw new ApiError("INPUT_REQUIRED", "Password is empty");
      }
    }
    const token =
      operation.security?.length === 0
        ? undefined
        : await sessionToken(credentials, baseUrl, env.ADMINBOT_TOKEN, env);
    const requiresAuth =
      (operation.security ?? document.security).length > 0 &&
      (operation.security ?? document.security).every(
        (requirement) => Object.keys(requirement).length > 0,
      );
    if (requiresAuth && !token) {
      throw new ApiError("AUTH_REQUIRED", "Run auth login or set ADMINBOT_TOKEN", 401);
    }
    let result = await callOperation(operation.operationId, {
      baseUrl,
      token,
      path: parsed.path,
      query: parsed.query,
      header: parsed.header,
      body,
      timeout,
      fetchImpl,
    });
    if (login) {
      if (typeof result?.session_token !== "string" || typeof result?.expires_at !== "string") {
        throw new ApiError("INVALID_RESPONSE", "Invalid login response");
      }
      await forgetSavedSecret(credentials, env);
      await saveSession(credentials, {
        url: baseUrl,
        token: result.session_token,
        expires_at: result.expires_at,
      });
      result = { authenticated: true, expires_at: result.expires_at };
    }
    if (operation.operationId === "post-auth-logout") {
      await clearSession(credentials, baseUrl, token, env);
      result = { authenticated: false };
    }
    if (values.output) {
      await writeFile(
        values.output,
        Buffer.isBuffer(result)
          ? result
          : typeof result === "string"
            ? result
            : `${JSON.stringify(result, null, 2)}\n`,
        { mode: 0o600 },
      );
    } else if (Buffer.isBuffer(result)) {
      throw new ApiError("OUTPUT_REQUIRED", "Binary response; provide --output PATH");
    } else {
      stdout.write(typeof result === "string" ? result : `${JSON.stringify(result, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    const known = error instanceof ApiError;
    const status = known ? error.status : undefined;
    stderr.write(
      `${JSON.stringify({ error: { code: known ? error.code : "CLI_ERROR", message: known ? redact(error.message) : "CLI failed; check input and local file permissions", ...(status ? { status } : {}) } })}\n`,
    );
    // The service refusing the input is an input error, the same as the CLI refusing it.
    return [401, 403].includes(status)
      ? 3
      : status === 409
        ? 4
        : status === 400 || status === 422
          ? 2
          : status || ["CONNECTION_ERROR", "INVALID_RESPONSE", "SERVICE_ERROR"].includes(error.code)
            ? 1
            : 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
