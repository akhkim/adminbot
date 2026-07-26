import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { AdminBotStoredProposal } from "./contracts.js";
import type { AdminBotActionExecutor } from "./service-core.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 60_000;
const GOG_MAX_OUTPUT_BYTES = 1024 * 1024;

type GogRun = (args: string[]) => Promise<void>;
type GogCapture = (args: string[]) => Promise<string>;

export type GogAdminBotExecutorOptions = {
  env?: NodeJS.ProcessEnv;
  run?: GogRun;
};

export type GogSheetReadOptions = {
  env?: NodeJS.ProcessEnv;
  range?: string;
  capture?: GogCapture;
};

// Unbounded A1 range over the first tab, which is where Google Forms writes linked responses.
const DEFAULT_SHEET_RANGE = "A:ZZ";

/** Reads a spreadsheet range with the same non-interactive gog contract the executor uses. */
export async function readGogSheetRows(
  spreadsheetId: string,
  options: GogSheetReadOptions = {},
): Promise<string[][]> {
  const id = spreadsheetId.trim();
  if (!id) {
    throw new Error("gog sheets get requires a spreadsheet id");
  }
  const capture = options.capture ?? createGogCapture(options.env);
  const args = rootArgs("sheets.get", optionalAccount(options.env));
  args.push("--readonly", "sheets", "get", id, options.range?.trim() || DEFAULT_SHEET_RANGE);
  return parseGogSheetRows(await capture(args));
}

/**
 * gog wraps API results in an envelope whose shape varies per command, so locate the
 * Sheets `values` row matrix instead of assuming a fixed top-level key.
 */
export function parseGogSheetRows(output: string): string[][] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("gog sheets get did not return JSON output");
  }
  return findRowMatrix(parsed) ?? [];
}

function findRowMatrix(value: unknown): string[][] | undefined {
  if (Array.isArray(value)) {
    return isRowMatrix(value) ? toRowMatrix(value) : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const values = record.values;
  if (Array.isArray(values) && isRowMatrix(values)) {
    return toRowMatrix(values);
  }
  for (const entry of Object.values(record)) {
    const found = findRowMatrix(entry);
    if (found) return found;
  }
  return undefined;
}

function isRowMatrix(value: unknown[]): boolean {
  return value.length > 0 && value.every((row) => Array.isArray(row));
}

function toRowMatrix(value: unknown[]): string[][] {
  return value.map((row) =>
    (row as unknown[]).map((cell) =>
      cell === undefined || cell === null ? "" : String(cell).trim(),
    ),
  );
}

function optionalAccount(env: NodeJS.ProcessEnv | undefined): string | undefined {
  return (env ?? process.env).GOG_ACCOUNT?.trim() || undefined;
}

export function createGogAdminBotExecutor(
  options: GogAdminBotExecutorOptions = {},
): AdminBotActionExecutor {
  const run = options.run ?? createGogRunner(options.env);
  return {
    async execute(proposal) {
      const args = buildGogArgs(proposal);
      if (!args) {
        return { handled: false };
      }
      await run(args);
      return { handled: true };
    },
  };
}

function buildGogArgs(proposal: AdminBotStoredProposal): string[] | undefined {
  switch (proposal.type) {
    case "email.draft":
      return buildEmailArgs(proposal, true);
    case "email.send":
      return buildEmailArgs(proposal, false);
    case "member_nudge.send": {
      // Shared with message-executor.ts (Slack-channel payloads); only the email-shaped half of
      // this action type belongs to gog.
      const payload = proposal.proposed_payload;
      const channel =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).channel
          : undefined;
      return channel === "email" ? buildEmailArgs(proposal, false) : undefined;
    }
    case "calendar.create_tentative_hold":
    case "calendar.send_invite":
      return buildCalendarCreateArgs(proposal);
    case "calendar.reschedule":
      return buildCalendarUpdateArgs(proposal);
    case "calendar.cancel":
      return buildCalendarDeleteArgs(proposal);
    default:
      return undefined;
  }
}

function buildEmailArgs(proposal: AdminBotStoredProposal, draft: boolean): string[] {
  const payload = requirePayload(proposal);
  const to = requireRecipients(payload, "to");
  const subject = requireString(payload, "subject");
  const body = requireString(payload, "body");
  const commandPath = draft ? "gmail.drafts.create" : "gmail.send";
  const args = rootArgs(commandPath, optionalString(payload, "account"));
  args.push("gmail", ...(draft ? ["drafts", "create"] : ["send"]));
  args.push("--to", to, "--subject", subject, "--body", body);
  appendOptional(args, "--cc", recipients(payload.cc));
  appendOptional(args, "--bcc", recipients(payload.bcc));
  appendOptional(args, "--reply-to", optionalString(payload, "reply_to"));
  return args;
}

function buildCalendarCreateArgs(proposal: AdminBotStoredProposal): string[] {
  const payload = requirePayload(proposal);
  const attendees = recipients(payload.attendees);
  if (proposal.type === "calendar.send_invite" && !attendees) {
    throw new Error("calendar.send_invite proposed_payload.attendees is required");
  }
  const args = rootArgs("calendar.create", optionalString(payload, "account"));
  args.push("calendar", "create", optionalString(payload, "calendar_id") ?? "primary");
  args.push(
    "--summary",
    requireString(payload, "summary"),
    "--from",
    requireString(payload, "from"),
    "--to",
    requireString(payload, "to"),
    "--send-updates",
    proposal.type === "calendar.send_invite" ? "all" : "none",
  );
  appendOptional(args, "--attendees", attendees);
  appendOptional(args, "--description", optionalString(payload, "description"));
  appendOptional(args, "--location", optionalString(payload, "location"));
  appendOptional(args, "--timezone", optionalString(payload, "timezone"));
  appendBoolean(args, "--all-day", payload.all_day);
  appendBoolean(args, "--with-meet", payload.with_meet);
  return args;
}

function buildCalendarUpdateArgs(proposal: AdminBotStoredProposal): string[] {
  const payload = requirePayload(proposal);
  const args = rootArgs("calendar.update", optionalString(payload, "account"));
  args.push(
    "calendar",
    "update",
    optionalString(payload, "calendar_id") ?? "primary",
    requireString(payload, "event_id"),
    "--from",
    requireString(payload, "from"),
    "--to",
    requireString(payload, "to"),
    "--send-updates",
    "all",
  );
  appendOptional(args, "--summary", optionalString(payload, "summary"));
  appendOptional(args, "--attendees", recipients(payload.attendees));
  appendOptional(args, "--description", optionalString(payload, "description"));
  appendOptional(args, "--location", optionalString(payload, "location"));
  appendOptional(args, "--timezone", optionalString(payload, "timezone"));
  return args;
}

function buildCalendarDeleteArgs(proposal: AdminBotStoredProposal): string[] {
  const payload = requirePayload(proposal);
  const args = rootArgs("calendar.delete", optionalString(payload, "account"), true);
  args.push(
    "calendar",
    "delete",
    optionalString(payload, "calendar_id") ?? "primary",
    requireString(payload, "event_id"),
    "--send-updates",
    "all",
  );
  return args;
}

function rootArgs(commandPath: string, account?: string, force = false): string[] {
  const args = ["--json", "--no-input", "--enable-commands-exact", commandPath];
  if (account) {
    args.push("--account", account);
  }
  if (force) {
    args.push("--force");
  }
  return args;
}

function requirePayload(proposal: AdminBotStoredProposal): Record<string, unknown> {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${proposal.type} requires an object proposed_payload`);
  }
  return payload as Record<string, unknown>;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = optionalString(payload, key);
  if (!value) {
    throw new Error(`proposed_payload.${key} is required`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`proposed_payload.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requireRecipients(payload: Record<string, unknown>, key: string): string {
  const value = recipients(payload[key]);
  if (!value) {
    throw new Error(`proposed_payload.${key} is required`);
  }
  return value;
}

function recipients(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new Error("recipient fields must be a non-empty string or string array");
  }
  return entries.map((entry) => (entry as string).trim()).join(",");
}

function appendOptional(args: string[], flag: string, value: string | undefined): void {
  if (value) {
    args.push(flag, value);
  }
}

function appendBoolean(args: string[], flag: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${flag} must be a boolean`);
  }
  if (value) {
    args.push(flag);
  }
}

function createGogRunner(env: NodeJS.ProcessEnv | undefined): GogRun {
  const capture = createGogCapture(env);
  return async (args) => {
    await capture(args);
  };
}

function createGogCapture(env: NodeJS.ProcessEnv | undefined): GogCapture {
  return async (args) => {
    try {
      const result = await execFile("gog", args, {
        env: env ?? process.env,
        maxBuffer: GOG_MAX_OUTPUT_BYTES,
        timeout: GOG_TIMEOUT_MS,
        windowsHide: true,
      });
      return result.stdout;
    } catch (error) {
      throw new Error(formatGogError(error), { cause: error });
    }
  };
}

function formatGogError(error: unknown): string {
  const failure = error as { code?: unknown; stderr?: unknown };
  if (failure?.code === "ENOENT") {
    return "gog executable was not found in the AdminBot service PATH";
  }
  const detail =
    typeof failure?.stderr === "string"
      ? failure.stderr
          .replace(/[\u0000-\u001f\u007f]+/gu, " ")
          .trim()
          .slice(0, 500)
      : "";
  const exitCode =
    typeof failure?.code === "number" || typeof failure?.code === "string"
      ? ` (exit ${String(failure.code)})`
      : "";
  return detail ? `gog command failed${exitCode}: ${detail}` : `gog command failed${exitCode}`;
}
