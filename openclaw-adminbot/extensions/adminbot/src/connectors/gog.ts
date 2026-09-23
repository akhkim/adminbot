import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotDriveProbe } from "../contracts/drive-links.js";
import type { AdminBotActionExecutor } from "../kernel/service.js";
import { renderEmailBodyHtml, renderEmailBodyText } from "./email-html.js";

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
  /** Reads, for the actions that must look at the live state before they write. */
  capture?: GogCapture;
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

export type GogSheetAppendOptions = {
  env?: NodeJS.ProcessEnv;
  range?: string;
  run?: GogRun;
};

/**
 * Appends rows after the last populated row of a range.
 *
 * `--input RAW` rather than the CLI's `USER_ENTERED` default: these cells are data, not things a
 * person typed. Under USER_ENTERED, Sheets parses each string the way it would parse typing -- a
 * leading `=`/`+`/`-` becomes a formula, and a value that looks like a date or a number is
 * silently coerced. A generated credential that Sheets decided was arithmetic is not the
 * credential any more, and nobody finds out until the sign-in fails.
 *
 * `--insert INSERT_ROWS` rather than the default OVERWRITE: OVERWRITE writes into whatever already
 * sits below the range's last populated row, so anything a human parked further down the sheet is
 * silently clobbered. INSERT_ROWS makes room instead.
 *
 * Refuses an empty row set rather than issuing a no-op API call, so "nothing was appended" can
 * never be reported to a caller as a successful append.
 */
export async function appendGogSheetRows(
  spreadsheetId: string,
  rows: string[][],
  options: GogSheetAppendOptions = {},
): Promise<void> {
  const id = spreadsheetId.trim();
  if (!id) {
    throw new Error("gog sheets append requires a spreadsheet id");
  }
  if (rows.length === 0) {
    throw new Error("gog sheets append refuses an empty row set");
  }
  const run = options.run ?? createGogRunner(options.env);
  const args = rootArgs("sheets.append", optionalAccount(options.env));
  args.push(
    "sheets",
    "append",
    id,
    options.range?.trim() || DEFAULT_SHEET_RANGE,
    "--input",
    "RAW",
    "--insert",
    "INSERT_ROWS",
    "--values-json",
    JSON.stringify(rows),
  );
  await run(args);
}

export type GogSheetTab = { title: string; gid: number };

/**
 * The tabs of a spreadsheet, as `{ title, gid }`.
 *
 * A gid is what a Google Sheets URL carries and what survives a rename; a tab title is what the
 * Sheets values API takes in an A1 range. Nothing else can bridge the two, so a deployment
 * configured by URL has to ask the spreadsheet what the tab it is pointed at is currently called.
 */
export async function readGogSheetTabs(
  spreadsheetId: string,
  options: Omit<GogSheetReadOptions, "range"> = {},
): Promise<GogSheetTab[]> {
  const id = spreadsheetId.trim();
  if (!id) {
    throw new Error("gog sheets metadata requires a spreadsheet id");
  }
  const capture = options.capture ?? createGogCapture(options.env);
  const args = rootArgs("sheets.metadata", optionalAccount(options.env));
  args.push("--readonly", "sheets", "metadata", id);
  return parseGogSheetTabs(await capture(args));
}

/**
 * Locates tab descriptors anywhere in gog's envelope.
 *
 * Same reasoning as `findRowMatrix`: the envelope shape varies per command, and the Sheets API
 * itself nests the pair under `sheets[].properties`, so match on the pair of fields rather than on
 * a path.
 */
export function parseGogSheetTabs(output: string): GogSheetTab[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("gog sheets metadata did not return JSON output");
  }
  const found = new Map<number, string>();
  collectSheetTabs(parsed, found);
  return [...found].map(([gid, title]) => ({ title, gid }));
}

function collectSheetTabs(value: unknown, into: Map<number, string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSheetTabs(entry, into);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  const title = record.title;
  // `sheetId` is the Sheets API spelling of a gid; `gid` is what some gog builds flatten it to.
  const rawGid = record.sheetId ?? record.gid;
  const gid =
    typeof rawGid === "number"
      ? rawGid
      : typeof rawGid === "string" && /^\d+$/u.test(rawGid.trim())
        ? Number(rawGid.trim())
        : undefined;
  if (typeof title === "string" && title.trim() && gid !== undefined && !into.has(gid)) {
    into.set(gid, title);
  }
  for (const entry of Object.values(record)) {
    collectSheetTabs(entry, into);
  }
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
  const capture = options.capture ?? createGogCapture(options.env);
  return {
    async execute(proposal) {
      if (proposal.type === "calendar.remove_attendees") {
        await removeCalendarAttendees(proposal, run, capture);
        return { handled: true };
      }
      if (
        proposal.type === "logistics.send_signed_document" ||
        // Same shape: bytes rather than paths, because the forms exist only as base64 on the
        // proposal and `--attach` wants files on disk.
        proposal.type === "reimbursement.submit"
      ) {
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
    args.push(
      "gmail",
      "send",
      "--to",
      to,
      "--subject",
      subject,
      "--body",
      renderEmailBodyText(body),
    );
    args.push("--body-html", optionalString(payload, "body_html") ?? renderEmailBodyHtml(body));
    for (const filePath of paths) {
      // Repeated rather than comma-joined: a file name containing a comma would otherwise split
      // into two paths that do not exist.
      args.push("--attach", filePath);
    }
    // The same three optionals the path-based sender takes. This branch used to drop them, which
    // was invisible while `logistics.send_signed_document` was its only caller and set none of
    // them -- but a reimbursement submitted with no reply-to lands in a finance inbox with the
    // bot as the only way to answer it, which is the one thing this send must not do.
    appendOptional(args, "--cc", recipients(payload.cc));
    appendOptional(args, "--bcc", recipients(payload.bcc));
    appendOptional(args, "--reply-to", optionalString(payload, "reply_to"));
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
    // Plain mail, no attachment: the letters themselves are not in it, only the fact that they are
    // due and where to read the requests.
    case "logistics.rec_letter_reminder":
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
    case "calendar.create_birthday":
    case "calendar.send_invite":
      return buildCalendarCreateArgs(proposal);
    case "calendar.reschedule":
      return buildCalendarUpdateArgs(proposal);
    case "calendar.add_attendees":
      return buildCalendarAddAttendeesArgs(proposal);
    case "calendar.cancel":
      return buildCalendarDeleteArgs(proposal);
    case "sheet.update_cells":
      return buildSheetUpdateArgs(proposal);
    case "sheet.append_rows":
      return buildSheetAppendArgs(proposal);
    default:
      return undefined;
  }
}

/**
 * The approval-gated twin of `appendGogSheetRows`, with the same `RAW` / `INSERT_ROWS` choices for
 * the same reasons: a typed value stays the value, and nothing a person parked below the roster is
 * overwritten.
 */
export function buildSheetAppendArgs(proposal: AdminBotStoredProposal): string[] {
  const payload = requirePayload(proposal);
  const spreadsheetId = requireString(payload, "spreadsheet_id");
  const range = requireString(payload, "range");
  const rows = payload.rows;
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    rows.some((row) => !Array.isArray(row) || row.length === 0)
  ) {
    throw new Error("sheet.append_rows proposed_payload.rows must be a non-empty row matrix");
  }
  const values = (rows as unknown[][]).map((row) =>
    row.map((cell) => (cell === undefined || cell === null ? "" : String(cell))),
  );
  const args = rootArgs("sheets.append", optionalString(payload, "account"));
  args.push(
    "sheets",
    "append",
    spreadsheetId,
    range,
    "--input",
    "RAW",
    "--insert",
    "INSERT_ROWS",
    "--values-json",
    JSON.stringify(values),
  );
  return args;
}

/**
 * One `sheets batch-update` for the whole edit, rather than one call per cell.
 *
 * Per-cell calls would leave the roster half-written when the fifth of nine fails, and this sheet
 * is what the onboarding and nudge sweeps read. A single API request either lands or does not.
 *
 * `--input RAW` on purpose: USER_ENTERED lets a cell beginning `=` become a live formula and one
 * beginning `+` or `-` be re-typed. An administrator editing a roster cell in a grid means the
 * text they typed, and a pasted value must never become a reference into somebody else's sheet.
 */
export function buildSheetUpdateArgs(proposal: AdminBotStoredProposal): string[] {
  const payload = requirePayload(proposal);
  const spreadsheetId = requireString(payload, "spreadsheet_id");
  const updates = payload.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("sheet.update_cells proposed_payload.updates must be a non-empty array");
  }
  const data = updates.map((entry) => {
    const update = entry as Record<string, unknown>;
    const range = typeof update.range === "string" ? update.range.trim() : "";
    if (!range) {
      throw new Error("sheet.update_cells update.range is required");
    }
    const values = update.values;
    if (!Array.isArray(values) || values.some((row) => !Array.isArray(row))) {
      throw new Error(`sheet.update_cells update.values for ${range} must be a row matrix`);
    }
    return {
      range,
      values: (values as unknown[][]).map((row) =>
        row.map((cell) => (cell === undefined || cell === null ? "" : String(cell))),
      ),
    };
  });

  const args = rootArgs("sheets.batch-update", optionalString(payload, "account"));
  args.push(
    "sheets",
    "batch-update",
    "--data-json",
    JSON.stringify(data),
    "--input",
    "RAW",
    spreadsheetId,
  );
  return args;
}

function buildEmailArgs(proposal: AdminBotStoredProposal, draft: boolean): string[] {
  const payload = requirePayload(proposal);
  const to = requireRecipients(payload, "to");
  const subject = requireString(payload, "subject");
  const body = requireString(payload, "body");
  const commandPath = draft ? "gmail.drafts.create" : "gmail.send";
  const args = rootArgs(commandPath, optionalString(payload, "account"));
  args.push("gmail", ...(draft ? ["drafts", "create"] : ["send"]));
  args.push("--to", to, "--subject", subject, "--body", renderEmailBodyText(body));
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
  // A recurring event is one row rather than one per year, which is what keeps a birthday on the
  // calendar without an annual job that can be missed.
  appendOptional(args, "--rrule", optionalString(payload, "rrule"));
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

/**
 * Take the people named in `removed_attendees` off each target event, and nobody else.
 *
 * There is no remove-attendee flag, so removal is a whole-list replace (`--attendees`). The list
 * written is computed here, from the event as it stands at execution, rather than taken from the
 * proposal: a proposal's `remaining_attendees` is a snapshot from whenever the sweep ran, and
 * writing it back days later uninvites everyone added in between. Subtracting from the live list
 * also makes the action idempotent -- an event none of the named people are still on is not
 * written at all, so re-approving, retrying after a timeout, or approving a duplicate proposal
 * does nothing instead of touching the event again.
 *
 * `event_ids` rather than one id because a standing meeting edited "this and following" becomes
 * several series, and a departure has to come off every one that still has Mondays ahead.
 *
 * Silent (`--send-updates none`). Google treats a whole-list replace as an edit for every guest,
 * so with `all` every remaining member got a fresh copy of the Monday meeting invite each time
 * somebody else was dropped. The people removed are not told either: a membership sweep tidying
 * the guest list is not news to anyone. gog sends bare `{email}` objects, so the write does reset
 * the remaining guests' RSVPs; it cannot be avoided through gog, and is why an event that needs
 * no change is never written.
 */
async function removeCalendarAttendees(
  proposal: AdminBotStoredProposal,
  run: GogRun,
  capture: GogCapture,
): Promise<void> {
  const payload = requirePayload(proposal);
  const removed = new Set(
    (recipients(payload.removed_attendees) ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  if (removed.size === 0) {
    throw new Error("calendar.remove_attendees proposed_payload.removed_attendees is required");
  }
  const calendarId = optionalString(payload, "calendar_id") ?? "primary";
  const account = optionalString(payload, "account");
  const listed = Array.isArray(payload.event_ids)
    ? payload.event_ids.filter((id): id is string => typeof id === "string" && !!id.trim())
    : [];
  const eventIds = listed.length > 0 ? listed : [requireString(payload, "event_id")];

  for (const eventId of eventIds) {
    const readArgs = rootArgs("calendar.event", account);
    readArgs.push("calendar", "event", calendarId, eventId);
    const attendees = parseEventAttendees(await capture(readArgs), eventId);
    const keep = attendees.filter((attendee) => !removed.has(attendee.email.toLowerCase()));
    if (keep.length === attendees.length) {
      continue;
    }
    // An empty result is refused: "remove everybody" is never what a membership sweep means, and
    // it is exactly what a read that came back without its guest list looks like.
    if (keep.length === 0) {
      throw new Error(
        `calendar.remove_attendees refuses to empty the guest list of event ${eventId}`,
      );
    }
    const args = rootArgs("calendar.update", account);
    args.push(
      "calendar",
      "update",
      calendarId,
      eventId,
      "--attendees",
      keep.map(attendeeSpec).join(","),
      "--send-updates",
      "none",
    );
    await run(args);
  }
}

type EventAttendee = { email: string; optional: boolean; resource: boolean };

function parseEventAttendees(stdout: string, eventId: string): EventAttendee[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`gog calendar event ${eventId} did not return JSON: ${stdout.slice(0, 200)}`);
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const event = (
    record.event && typeof record.event === "object" ? record.event : record
  ) as Record<string, unknown>;
  if (!Array.isArray(event.attendees)) {
    // An event with no guest list at all cannot be the meeting a removal was planned against.
    throw new Error(`gog calendar event ${eventId} returned no attendee list`);
  }
  return event.attendees.flatMap((entry) => {
    const attendee = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const email = typeof attendee.email === "string" ? attendee.email.trim() : "";
    return email
      ? [{ email, optional: attendee.optional === true, resource: attendee.resource === true }]
      : [];
  });
}

// gog's modifier syntax, so a replace does not quietly turn optional guests into required ones or a
// booked room into a person.
function attendeeSpec(attendee: EventAttendee): string {
  return `${attendee.email}${attendee.optional ? ";optional" : ""}${attendee.resource ? ";resource" : ""}`;
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
 * Ask Google whether one Drive file is there, and what it is called.
 *
 * A metadata read, not a download: proving a link points at something real should not put a copy
 * of somebody's paper on disk. Outside the proposal gate for the same reason `readDriveFileBase64`
 * is -- nothing is written and nothing leaves the lab -- and it shells to the same `gog`, so it
 * inherits one auth story rather than inventing a second.
 *
 * Never throws. A probe is a question the lab asks about its own records, and the answer "I could
 * not tell" has to be available to the caller as an answer rather than as a stack trace: a paper
 * must not stall because a network blinked. The three outcomes are the contract's own, and only
 * `missing` is Google actually saying the file is not there.
 */
export function createGogDriveProbe(
  options: { command?: string; commandArgsPrefix?: string[]; env?: NodeJS.ProcessEnv } = {},
): AdminBotDriveProbe {
  const command = options.command ?? "gog";
  return async (fileId) => {
    // The id comes from `adminBotDriveFileId`, which accepts a closed charset -- but this is the
    // last point before it becomes an argument, so it is checked here too rather than trusted.
    if (!/^[A-Za-z0-9_-]{10,200}$/u.test(fileId)) {
      return { status: "unreadable", reason: "not a Drive file id" };
    }
    const args = [
      ...(options.commandArgsPrefix ?? []),
      ...rootArgs("drive.get", optionalAccount(options.env)),
      "drive",
      "get",
      fileId,
      "--fields",
      "id,name,trashed",
    ];
    try {
      const { stdout } = await execFile(command, args, {
        maxBuffer: GOG_MAX_OUTPUT_BYTES,
        timeout: GOG_TIMEOUT_MS,
        ...(options.env ? { env: options.env } : {}),
      });
      const payload = JSON.parse(stdout) as Record<string, unknown>;
      const file = (payload.result ?? payload) as Record<string, unknown>;
      const name = typeof file.name === "string" ? file.name : undefined;
      return {
        status: "found",
        ...(name ? { name } : {}),
        ...(file.trashed === true ? { trashed: true } : {}),
      };
    } catch (error) {
      const text = `${(error as { stderr?: string }).stderr ?? ""} ${(error as Error).message ?? ""}`;
      // Google's own "there is no such file" and "you cannot see it" are different sentences, and
      // only the first is evidence about the artifact. Anything else -- no account, a timeout, a
      // gog that is not installed -- is the lab failing to ask, not the file failing to exist.
      return /not ?found|404|does not exist/iu.test(text)
        ? { status: "missing" }
        : { status: "unreadable", reason: firstLine(text) };
    }
  };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 200) || "gog gave no reason";
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
