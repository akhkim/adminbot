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
  validateInput,
  document,
  operations,
  serviceOrigin,
  suggest,
} from "./client.mjs";
import { deviceLogin } from "./login.mjs";
import { installSkill } from "./skill.mjs";

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
adminbot skill install                        Install the agent skill for Claude Code and Codex

Sign-in (one click in the browser, like gh and Modal):
  adminbot login                              Approve once; the token lasts until revoked or unused 90 days
  adminbot login --no-browser                 Print the link instead of opening it (agents, SSH)
  adminbot login --insecure-storage           Keep the token in the credentials file, not the Keychain
  adminbot whoami                             Who you are signed in as (also: auth status)
  adminbot auth token                         Print the token, e.g. ADMINBOT_TOKEN=$(adminbot auth token)
  adminbot logout                             Revoke this machine's token

Examples:
  adminbot papers list
  adminbot work update PAPER_ID --note "Finished experiments"
  adminbot tasks update PAPER_ID fixes_merged --done
  adminbot papers progress PAPER_ID --step overleaf_writing
  adminbot auth tokens list

Input fields become --kebab-case flags; arrays accept repeated flags.
Nested/dynamic fields: --set FIELD.PATH=VALUE; dynamic query: --query NAME=VALUE. Optional JSON: --file PATH or --file -.
Booleans: --done / --no-done. Dry-run operations need --live for real execution.
Global options (after the command): --url ORIGIN, --timeout MS, --output PATH, --json, --help.
adminbot --version prints the CLI version.
Default: ${document.servers[0].url}; ADMINBOT_URL overrides it.
Auth: saved login (macOS Keychain, else a private file) or ADMINBOT_TOKEN; never put secrets in argv.
Exit codes: 0 success, 1 service/network, 2 input, 3 auth/permission, 4 conflict.

Errors go to stderr as one JSON line (stdout stays empty):
  {"error":{"code":"…","message":"what went wrong and why","exit_code":2,"retryable":false,
            "hint":"the next command to run","operation":"…","status":403,"details":{…}}}
  retryable: true means the same command may simply be repeated. details may hold
  suggestions, valid_flags, missing, problems (field/problem/allowed), the server's
  server_code, retry_after_seconds, and may_have_applied (a write that may have
  happened: re-read before repeating).
`;
async function stdinText(stream) {
  if (stream.isTTY) {
    throw new ApiError(
      "INPUT_REQUIRED",
      "This reads from stdin, but stdin is a terminal; pipe the input in (e.g. `cat body.json | adminbot … --file -`) or pass --file PATH",
    );
  }
  let raw = "";
  for await (const chunk of stream) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) {
      throw new ApiError(
        "INPUT_TOO_LARGE",
        "stdin input is over the 1 MiB limit; send a smaller body or split the change into several calls",
      );
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
function unknownOperation(name) {
  const suggestions = suggest(name, Object.keys(operations));
  return new ApiError(
    "UNKNOWN_OPERATION",
    name
      ? `No operation named ${JSON.stringify(name)}${suggestions.length ? `. Did you mean ${suggestions.join(" or ")}?` : ""}`
      : "Name an operation ID, e.g. adminbot call get-deadlines",
    undefined,
    {
      hint: suggestions[0]
        ? `adminbot call ${suggestions[0]} --help`
        : "adminbot operations | grep WORD",
      details: { suggestions },
    },
  );
}
function findCommand(argv) {
  if (argv[0] === "call") {
    if (!operations[argv[1]]) {
      throw unknownOperation(argv[1]);
    }
    return { alias: { operation: argv[1] }, args: argv.slice(2) };
  }
  if (operations[argv[0]]) {
    // `adminbot get-deadlines` is a common slip for `adminbot call get-deadlines`.
    return { alias: { operation: argv[0] }, args: argv.slice(1) };
  }
  for (let length = argv.length; length > 0; length--) {
    const alias = commandIndex.get(argv.slice(0, length).join(" "));
    if (alias) {
      return { alias, args: argv.slice(length) };
    }
  }
  const typed = argv.filter((arg) => !arg.startsWith("-")).join(" ");
  if (!typed) {
    throw new ApiError(
      "UNKNOWN_COMMAND",
      `${argv[0]} is not a top-level option. The only top-level options are --help and --version; every other flag goes after a command (adminbot COMMAND --flag)`,
      undefined,
      { hint: "adminbot --help" },
    );
  }
  const suggestions = suggest(typed, [
    ...[...commandIndex.keys()].filter((words) => commandIndex.get(words)),
    ...Object.keys(operations),
  ]);
  throw new ApiError(
    "UNKNOWN_COMMAND",
    `No command matches ${JSON.stringify(typed)}${suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : "."} Every operation also runs as adminbot call OPERATION_ID.`,
    undefined,
    {
      hint: suggestions[0]
        ? `adminbot ${operations[suggestions[0]] ? "call " : ""}${suggestions[0]} --help`
        : "adminbot operations | grep WORD",
      details: { suggestions },
    },
  );
}

const LOGIN_USAGE =
  "Usage: adminbot login [--name NAME] [--days 1-365] [--no-browser] [--insecure-storage] [--url ORIGIN] [--timeout MS]";
// gh-style shortcuts: `adminbot login` is `adminbot auth login`, and so on.
const TOP_LEVEL = { login: "login", logout: "logout", whoami: "whoami" };

/** `auth login` without --email or --file: the browser handshake that issues a personal API token. */
function deviceLoginArgs(argv) {
  if (argv[0] !== "auth" || argv[1] !== "login") {
    return undefined;
  }
  const args = argv.slice(2);
  if (
    args.some((arg) =>
      ["--email", "--file", "--password-stdin", "--help", "-h"].includes(arg.split("=")[0]),
    )
  ) {
    return undefined;
  }
  const options = { browser: true, insecureStorage: false };
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split(/[=](.*)/su);
    if (flag === "--no-browser" && inline === undefined) {
      options.browser = false;
      continue;
    }
    if (flag === "--insecure-storage" && inline === undefined) {
      options.insecureStorage = true;
      continue;
    }
    if (!["--name", "--days", "--url", "--timeout"].includes(flag)) {
      // Name the flag but never echo a value: someone may have pasted a password or token.
      throw new ApiError(
        "INVALID_ARGUMENTS",
        `${flag.startsWith("-") ? `Unknown login option ${flag.slice(0, 40)}` : "Unexpected value"}. ${LOGIN_USAGE}. Login never takes a password: you approve in the browser.`,
        undefined,
        { hint: "adminbot login --no-browser" },
      );
    }
    const value = inline ?? args[++index];
    if (value === undefined) {
      throw new ApiError("INVALID_ARGUMENTS", `${flag} needs a value. ${LOGIN_USAGE}`);
    }
    options[flag.slice(2)] = value;
  }
  if (options.days !== undefined) {
    options.days = Number(options.days);
    if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 365) {
      throw new ApiError(
        "INVALID_ARGUMENTS",
        "--days must be a whole number from 1 to 365; leave it out for a token that lasts until revoked or unused for 90 days",
      );
    }
  }
  return options;
}
function requestTimeout(value) {
  const timeout = Number(value ?? 30000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) {
    throw new ApiError(
      "INVALID_ARGUMENTS",
      "--timeout is in milliseconds and must be a whole number from 1 to 300000 (default 30000)",
    );
  }
  return timeout;
}
// A token pasted into a flag or echoed back by a proxy must not reach a terminal log or an agent
// transcript through an error message.
const redact = (text) => text.replace(/abt_[A-Za-z0-9_-]{8,}/gu, "abt_[REDACTED]");
// The next command to run, for a person or an agent reading the error, when the error itself
// did not name one.
function hintFor(code, status, operationId) {
  if (["AUTH_REQUIRED", "SESSION_EXPIRED", "LOGIN_EXPIRED"].includes(code) || status === 401) {
    return "adminbot login";
  }
  if (code === "UNKNOWN_COMMAND" || code === "UNKNOWN_OPERATION") {
    return "adminbot operations";
  }
  if (["INVALID_INPUT", "INVALID_ARGUMENTS"].includes(code) && operationId) {
    return `adminbot call ${operationId} --help`;
  }
  if (status === 409) {
    return "re-read the record, then decide";
  }
  return undefined;
}
function exitCode(code, status) {
  // The service refusing the input is an input error, the same as the CLI refusing it.
  if ([401, 403].includes(status) || ["AUTH_REQUIRED", "ACCESS_DENIED"].includes(code)) {
    return 3;
  }
  if (status === 409) {
    return 4;
  }
  if (status === 400 || status === 422) {
    return 2;
  }
  return status ||
    [
      "CONNECTION_ERROR",
      "INVALID_RESPONSE",
      "SERVICE_ERROR",
      "KEYCHAIN_ERROR",
      "LOCAL_FILE_ERROR",
      "CLI_ERROR",
    ].includes(code)
    ? 1
    : 2;
}
// Unexpected exceptions keep their real cause: an agent can act on "EACCES: permission denied,
// open '/x'" but not on "something failed".
function unexpected(error) {
  if (error?.syscall || /^E[A-Z]+$/u.test(error?.code ?? "")) {
    return new ApiError(
      "LOCAL_FILE_ERROR",
      `${error.syscall ?? "file operation"} failed: ${error.message}`,
      undefined,
      {
        hint:
          error.code === "ENOENT"
            ? "check the path exists"
            : error.code === "EACCES" || error.code === "EPERM"
              ? "check the file's permissions"
              : undefined,
        details: { system_code: error.code, ...(error.path ? { path: error.path } : {}) },
      },
    );
  }
  return new ApiError(
    "CLI_ERROR",
    `Unexpected ${error?.name ?? "error"}: ${String(error?.message ?? error).slice(0, 300)}. This is a CLI bug; report the command that caused it.`,
  );
}

export async function run(
  rawArgv,
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  let operationId;
  try {
    const argv = Object.hasOwn(TOP_LEVEL, rawArgv[0] ?? "")
      ? ["auth", TOP_LEVEL[rawArgv[0]], ...rawArgv.slice(1)]
      : rawArgv;
    if (!argv.length || ["--help", "-h", "help"].includes(argv[0])) {
      stdout.write(help);
      return 0;
    }
    if (["--version", "-V", "version"].includes(argv[0])) {
      const { version } = JSON.parse(
        await readFile(new URL("package.json", import.meta.url), "utf8"),
      );
      stdout.write(`adminbot ${version}\n`);
      return 0;
    }
    if (argv[0] === "schema") {
      if (argv.length > 2) {
        throw new ApiError("INVALID_ARGUMENTS", "Usage: adminbot schema [OPERATION_ID]");
      }
      if (argv[1] && !operations[argv[1]]) {
        throw unknownOperation(argv[1]);
      }
      stdout.write(
        `${JSON.stringify(argv[1] ? { ...operations[argv[1]], components: document.components } : document, null, 2)}\n`,
      );
      return 0;
    }
    if (argv[0] === "skill") {
      if (argv.length !== 2 || argv[1] !== "install") {
        throw new ApiError(
          "INVALID_ARGUMENTS",
          "Usage: adminbot skill install (copies the agent skill into ~/.claude/skills and ~/.codex/skills)",
        );
      }
      stdout.write(`${JSON.stringify(await installSkill(env), null, 2)}\n`);
      return 0;
    }
    if (argv[0] === "operations") {
      if (argv.slice(1).some((arg) => arg !== "--json")) {
        throw new ApiError(
          "INVALID_ARGUMENTS",
          "Usage: adminbot operations [--json]; it takes no filter, so pipe it: adminbot operations | grep WORD",
        );
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
        env: browserLogin.insecureStorage ? { ...env, ADMINBOT_KEYCHAIN: "0" } : env,
        stderr,
        fetchImpl,
      });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (argv[0] === "auth" && argv[1] === "token") {
      // Like `gh auth token`: for handing the saved login to another tool, never for a transcript.
      const [flag, inline] = (argv[2] ?? "").split(/[=](.*)/su);
      if (argv.length > 4 || (argv[2] && flag !== "--url")) {
        throw new ApiError("INVALID_ARGUMENTS", "Usage: adminbot auth token [--url ORIGIN]");
      }
      const origin = serviceOrigin(
        (flag === "--url" ? (inline ?? argv[3]) : undefined) ??
          env.ADMINBOT_URL ??
          document.servers[0].url,
      );
      const saved = await sessionToken(credentials, origin, env.ADMINBOT_TOKEN, env);
      if (!saved) {
        throw new ApiError(
          "AUTH_REQUIRED",
          `Not signed in to ${origin}: no saved login and ADMINBOT_TOKEN is unset`,
          401,
        );
      }
      stdout.write(`${saved}\n`);
      return 0;
    }
    const { alias, args } = findCommand(argv);
    const operation = operations[alias.operation];
    operationId = operation.operationId;
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
        const source = values.file === "-" ? "stdin" : values.file;
        throw new ApiError(
          "INVALID_INPUT",
          error instanceof SyntaxError
            ? `--file ${source} is not valid JSON: ${error.message}`
            : `Cannot read --file ${source}: ${error.code === "ENOENT" ? "no such file" : (error.code ?? error.message)}`,
          undefined,
          { hint: `adminbot schema ${operationId}`, details: { file: source } },
        );
      }
    }
    if (operation.requestBody && Object.hasOwn(bodyFields(operation), "dry_run")) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(
          "INVALID_INPUT",
          `The request body must be a JSON object ({...}), not ${Array.isArray(body) ? "an array" : body === null ? "null" : typeof body}`,
        );
      }
      body = { ...body, dry_run: values.live !== true };
    }
    const login = operation.operationId === "post-auth-login";
    if (login && !values.file) {
      if (!values["password-stdin"] || !body.email?.trim()) {
        throw new ApiError(
          "INPUT_REQUIRED",
          "Password login needs --email ADDRESS --password-stdin with the password piped in. Prefer the browser login, which needs no password.",
          undefined,
          { hint: "adminbot login" },
        );
      }
      body.password = (await stdinText(stdin)).replace(/\r?\n$/u, "");
      if (!body.password) {
        throw new ApiError("INPUT_REQUIRED", "The password piped on stdin is empty");
      }
    }
    validateInput(operation, { ...parsed, body });
    const token =
      operation.security?.length === 0
        ? undefined
        : await sessionToken(credentials, baseUrl, env.ADMINBOT_TOKEN, env);
    const requiresAuth =
      (operation.security ?? document.security).length > 0 &&
      (operation.security ?? document.security).every(
        (requirement) => Object.keys(requirement).length > 0,
      );
    if (operation.operationId === "post-auth-logout" && !token) {
      // Nothing to revoke: logging out is already done, which is what the caller wanted.
      stdout.write(
        `${JSON.stringify({ authenticated: false, note: `No saved login for ${baseUrl}` }, null, 2)}\n`,
      );
      return 0;
    }
    if (requiresAuth && !token) {
      throw new ApiError(
        "AUTH_REQUIRED",
        `${operationId} needs a signed-in caller, but there is no saved login for ${baseUrl} and ADMINBOT_TOKEN is unset. Sign in with one browser click (agents: add --no-browser and show the user the link).`,
        401,
      );
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
        throw new ApiError(
          "INVALID_RESPONSE",
          "The login answer had no session_token/expires_at; the server may be older than this CLI or not AdminBot",
        );
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
      throw new ApiError(
        "OUTPUT_REQUIRED",
        `${operationId} returned a binary file, which is never written to the terminal; repeat with --output PATH`,
        undefined,
        { hint: `adminbot ${argv.join(" ")} --output ./${operationId}.bin` },
      );
    } else {
      stdout.write(typeof result === "string" ? result : `${JSON.stringify(result, null, 2)}\n`);
    }
    return 0;
  } catch (caught) {
    const error = caught instanceof ApiError ? caught : unexpected(caught);
    const { code, status, details } = error;
    const exit = exitCode(code, status);
    const hint = error.hint ?? hintFor(code, status, operationId);
    stderr.write(
      `${redact(
        JSON.stringify({
          error: {
            code,
            message: error.message,
            exit_code: exit,
            retryable: error.retryable ?? false,
            ...(hint ? { hint } : {}),
            ...(operationId ? { operation: operationId } : {}),
            ...(status ? { status } : {}),
            ...(details && Object.keys(details).length ? { details } : {}),
          },
        }),
      )}\n`,
    );
    return exit;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
