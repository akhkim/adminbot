import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotActionExecutor } from "../kernel/service.js";
import { renderEmailBodyHtml } from "./email-html.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 60_000;
const GOG_MAX_OUTPUT_BYTES = 1024 * 1024;

// The AdminBot systemd unit's PATH is a fixed list that doesn't always match whatever an
// interactive shell resolves 'gog' to (e.g. after a fresh ~/.local/bin install), so a bare
// 'gog' exec can ENOENT in production even though it works in a terminal. Mirrors the
// GOG_BIN/homedir fallback resolution scripts/adminbot-email-automation.ts already uses.
const GOG_EXECUTABLE = resolveGogExecutable();

// Exported so every gog caller resolves the binary the same way: the service's systemd unit runs
// with a minimal PATH that does not include ~/.local/bin, so a bare "gog" lookup ENOENTs there
// even though it works in an interactive shell.
export function resolveGogExecutable(env?: NodeJS.ProcessEnv): string {
  const source = env ?? process.env;
  const candidates = [source.GOG_BIN ?? "", path.join(os.homedir(), ".local", "bin", "gog")];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  // Last resort: rely on PATH resolution, same as before this fallback existed.
  return "gog";
}

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

export type GogDocWriteOptions = {
  env?: NodeJS.ProcessEnv;
  // Which tab to replace. Google Docs put everything in a single tab ("t.0") unless someone adds
  // more, and replacing the wrong one would silently write to a tab nobody reads.
  tab?: string;
  run?: GogRun;
};

const DEFAULT_DOC_TAB = "t.0";

/**
 * Replaces a Google Doc's body with rendered markdown.
 *
 * The markdown goes to a scratch file rather than stdin: `--file -` would work, but the shared
 * runner here is execFile-based with no stdin plumbing, and a temp file is the same shape
 * sendWithAttachments already uses. The directory is removed either way -- a failed write should
 * not leave lab CV history sitting in /tmp on a shared box.
 *
 * `--replace` rather than `--append`: the document is a full rendering of the ledger, so appending
 * would duplicate every prior entry on each run.
 */
export async function writeGogDocMarkdown(
  documentId: string,
  markdown: string,
  options: GogDocWriteOptions = {},
): Promise<void> {
  const id = documentId.trim();
  if (!id) {
    throw new Error("gog docs write requires a document id");
  }
  if (!markdown.trim()) {
    // Replacing a document with nothing is almost always a rendering bug upstream, and it destroys
    // whatever the last good run published. Refused rather than executed.
    throw new Error("gog docs write refuses an empty document body");
  }
  const run = options.run ?? createGogRunner(options.env);
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adminbot-doc-"));
  try {
    const filePath = path.join(scratch, "body.md");
    await fs.promises.writeFile(filePath, markdown, "utf8");
    const args = rootArgs("docs.write", optionalAccount(options.env));
    args.push(
      "docs",
      "write",
      id,
      "--file",
      filePath,
      "--markdown",
      "--replace",
      "--tab",
      options.tab?.trim() || DEFAULT_DOC_TAB,
    );
    await run(args);
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}

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
      if (proposal.type === "logistics.send_signed_document") {
        await sendWithAttachments(proposal, run);
        return { handled: true };
      }
      const args = buildGogArgs(proposal);
      if (!args) {
        return { handled: false };
      }
      await run(args);
      return { handled: true };
    },
  };
}

/**
 * An email whose attachments arrive as bytes rather than as paths.
 *
 * Its own path because `--attach` takes file paths and the signed document exists only as base64 in
 * the proposal, so the bytes have to touch a disk somewhere. The scratch directory is removed
 * whether or not the send worked: it holds somebody's signed paperwork, and it has no business
 * outliving the call on a shared box.
 */
async function sendWithAttachments(proposal: AdminBotStoredProposal, run: GogRun): Promise<void> {
  const payload = requirePayload(proposal);
  const to = requireRecipients(payload, "to");
  const subject = requireString(payload, "subject");
  const body = requireString(payload, "body");
  const attachments = readAttachments(payload);
  if (!attachments.length) {
    throw new Error(`${proposal.type} requires at least one attachment`);
  }
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adminbot-signed-"));
  try {
    const paths: string[] = [];
    for (const attachment of attachments) {
      const filePath = path.join(scratch, safeAttachmentName(attachment.name));
      await fs.promises.writeFile(filePath, Buffer.from(attachment.data_base64, "base64"));
      paths.push(filePath);
    }
    const args = rootArgs("gmail.send", optionalString(payload, "account"));
    args.push("gmail", "send", "--to", to, "--subject", subject, "--body", body);
    args.push("--body-html", optionalString(payload, "body_html") ?? renderEmailBodyHtml(body));
    for (const filePath of paths) {
      // Repeated rather than comma-joined: a file name containing a comma would otherwise split
      // into two paths that do not exist.
      args.push("--attach", filePath);
    }
    await run(args);
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}

function readAttachments(
  payload: Record<string, unknown>,
): { name: string; data_base64: string }[] {
  const raw = payload.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const data = typeof record.data_base64 === "string" ? record.data_base64 : "";
    return name && data ? [{ name, data_base64: data }] : [];
  });
}

/** The name the recipient sees, with anything that could steer a path taken out of it. */
export function safeAttachmentName(name: string): string {
  const cleaned = path
    .basename(name.trim())
    .replace(/[^\w.\- ]+/gu, "_")
    .slice(0, 120);
  return cleaned || "document";
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
    case "calendar.add_attendees":
      return buildCalendarAddAttendeesArgs(proposal);
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
  // gog sends `--body` as text/plain, which the delivery path soft-wraps and the reading client
  // then re-wraps -- the ~70-character breaks the operator sees mid-paragraph. `--body-html` adds
  // an alternative part that is not wrapped; `--body` stays, so a text-only client still gets the
  // canonical copy. Both the send and the draft path take it.
  //
  // Rendered here rather than at each caller: a proposal reaches this connector from the agent's
  // `email.send`/`email.draft` pipeline, which has no place to put an html alternative and no
  // business generating markup. An explicit `body_html` still wins, so a caller that already
  // renders one (guide-sender, account-approved-email) is unaffected.
  // `body` is already required non-empty above, so the render is never the empty string.
  appendOptional(
    args,
    "--body-html",
    optionalString(payload, "body_html") ?? renderEmailBodyHtml(body),
  );
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

/**
 * Adds people to an event without touching anything else about it.
 *
 * `--add-attendee` rather than `--attendees`: the latter *replaces* the guest list, so inviting two
 * people to a standing meeting would quietly uninvite everyone already on it. Nothing else is
 * passed, so an invite cannot move an event or rewrite its title as a side effect.
 */
function buildCalendarAddAttendeesArgs(proposal: AdminBotStoredProposal): string[] {
  const payload = requirePayload(proposal);
  const attendees = recipients(payload.attendees);
  if (!attendees) {
    throw new Error("calendar.add_attendees proposed_payload.attendees is required");
  }
  const args = rootArgs("calendar.update", optionalString(payload, "account"));
  args.push(
    "calendar",
    "update",
    optionalString(payload, "calendar_id") ?? "primary",
    requireString(payload, "event_id"),
    "--add-attendee",
    attendees,
    "--send-updates",
    "all",
  );
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

/**
 * Download one Drive file and return it base64-encoded.
 *
 * Its own function rather than a proposal: nothing leaves the lab and nothing is written, so the
 * propose/approve/execute gate has nothing to protect here -- this is a read, in service of a
 * draft the author is about to look at. It shells to the same `gog` every other Google action
 * uses, so it inherits one auth story rather than inventing a second.
 */
export async function readDriveFileBase64(
  fileId: string,
  options: { command?: string; commandArgsPrefix?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const command = options.command ?? "gog";
  const output = path.join(
    os.tmpdir(),
    `adminbot-drive-${fileId.replace(/[^a-zA-Z0-9_-]/gu, "")}-${Date.now()}.pdf`,
  );
  const args = [
    ...(options.commandArgsPrefix ?? []),
    ...rootArgs("drive.download", optionalAccount(options.env)),
    "drive",
    "download",
    fileId,
    "--output",
    output,
  ];
  try {
    await execFile(command, args, {
      maxBuffer: GOG_MAX_OUTPUT_BYTES,
      timeout: GOG_TIMEOUT_MS,
      ...(options.env ? { env: options.env } : {}),
    });
    return (await fs.promises.readFile(output)).toString("base64");
  } finally {
    // Best effort: a leftover temp PDF is a copy of a paper sitting on disk, so it goes even when
    // the download failed halfway.
    await fs.promises.rm(output, { force: true }).catch(() => {});
  }
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
      const result = await execFile(GOG_EXECUTABLE, args, {
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
