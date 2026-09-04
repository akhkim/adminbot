#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  adminBotPaperflowEvidenceMinConfidence,
  createAdminBotSqliteService,
  ensureAdminBotEmailReviewSchema,
  isAdminBotPaperflowStage,
  looksLikeZoomRecordingNotice,
  noticeToMeeting,
  renderEmailBodyHtml,
} from "../extensions/adminbot/api.js";
import { getSlackWriteClient, resolveSlackAccount } from "../extensions/slack/api.js";
import { loadConfig } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types/openclaw.js";
import { resolveSecretInputString } from "../src/secrets/resolve-secret-input-string.js";
import { downloadLinkedDriveFiles } from "./adminbot-drive-download.js";
import {
  AdminBotEmailModel,
  GMAIL_SCAN_DEFAULT_LOOKBACK_MS,
  gmailScanQuery,
  type EmailReplyPurpose,
  type ModelClassification,
  type ModelEmailDraft,
  type PaperflowCandidate,
} from "./adminbot-email-model.js";
import { isMainModule } from "./lib/is-main-module.mjs";

const execFileAsync = promisify(execFile);
// Every address, calendar and channel below identifies a specific workspace, so it is deployment
// configuration and not a tracked constant. They are read through functions rather than at module
// load: this file is imported for its pure classifiers too, and a top-level throw would take those
// down on a box that only ever runs the tests.
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set — the email automation cannot run without it`);
  }
  return value;
}

/** The mailbox the automation reads and sends as. */
const botEmail = () => requireEnv("ADMINBOT_BOT_EMAIL");
/** The shared lab calendar events are written to and read access is granted on. */
const jinesisCalendar = () => requireEnv("ADMINBOT_LAB_EMAIL");
/** Where reimbursement and error reports go; the first configured contact address. */
const adminRecipient = () =>
  addressList("ADMINBOT_CONTACT_EMAILS")[0] ?? requireEnv("ADMINBOT_CONTACT_EMAILS");
/** The Slack Connect channel onboarding invites land in. */
const slackChannel = () => requireEnv("ADMINBOT_ONBOARDING_CHANNEL_ID");

function addressList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

// Unset means nobody is privileged, not everybody: an unconfigured deployment must classify every
// sender as untrusted rather than hand a stranger the onboarding path.
const onboardingSenders = () => new Set(addressList("ADMINBOT_ONBOARDING_SENDERS"));
const privilegedSenders = () =>
  new Set([...onboardingSenders(), ...addressList("ADMINBOT_CONTACT_EMAILS")]);
const APPLICATION_FORM =
  "https://docs.google.com/forms/d/e/1FAIpQLSdyRYBiLPFUaaUC5v4ATIUwQpYPgmjRja33qwZFvH6BoIRCAA/viewform";
const DCS_FORM = "https://forms.office.com/r/TgGWBGWLZa";
// Onboarding emails cite the launch URL, but `requiredVerbatim` matches the origin: the model writes
// the link with or without the trailing slash, and the origin is a prefix of both renderings.
const CONTROL_UI_URL = "https://jinesis-admin.vercel.app/";
const CONTROL_UI_ORIGIN = "https://jinesis-admin.vercel.app";
const DEFAULT_TIMEZONE = "America/Toronto";

/**
 * Where a message ends up once this pass is finished with it.
 *
 * Labels rather than a trash call, which is what this used to do. Deleting a handled message made
 * the inbox a to-do list, which is the right shape, but it also threw away the only record of what
 * the automation actually did with a message -- and the failures, which are the ones somebody has
 * to act on, were left sitting in the inbox looking exactly like mail nobody had processed yet.
 *
 * So: every message the pass touches gets exactly one of these, and only the completed ones leave
 * the inbox. What is left in the inbox is then precisely the work outstanding, and each piece of it
 * says why it is there.
 */
const OUTCOME_LABELS = {
  completed: "AdminBot/Handled",
  needs_review: "AdminBot/Needs Review",
  failed: "AdminBot/Error",
} as const;

export type EmailOutcome = keyof typeof OUTCOME_LABELS;

const ALL_OUTCOME_LABELS = Object.values(OUTCOME_LABELS);

/**
 * The label change one outcome makes.
 *
 * Pure and exported so the filing rule can be asserted without a mailbox. The rule is small but
 * it is the whole feature: which labels come off matters as much as which goes on, because a
 * message that failed last hour and was handled this hour must not end up carrying both.
 */
export function outcomeLabelChange(outcome: EmailOutcome): { add: string[]; remove: string[] } {
  const add = OUTCOME_LABELS[outcome];
  const remove = ALL_OUTCOME_LABELS.filter((label) => label !== add);
  // Only a completed message leaves the inbox. What is left in the inbox is then exactly the work
  // still outstanding, which is the entire point of labelling rather than trashing.
  if (outcome === "completed") {
    remove.push("INBOX");
  }
  return { add: [add], remove };
}

export type EmailMessage = {
  id: string;
  threadId: string;
  from: string;
  fromName?: string;
  subject: string;
  body: string;
  internalDate?: string;
};

type OnboardingDecision = "trial" | "direct" | "decline";

type Classification = ModelClassification;

type CalendarEvent = {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  description?: string;
  location?: string;
};

type TalkEntry = {
  title: string;
  venue: string;
  location: string;
  date: string;
  upcoming: boolean;
};

type CommandResult = { stdout: string; stderr: string };

export type EmailAutomationSummary = {
  found: number;
  completed: number;
  failed: number;
  needs_review: number;
  skipped: number;
  errors: string[];
  /** Where this pass started reading, so a run that caught up says so in its own output. */
  scanned_since?: string;
  /** Where the watermark now stands. Absent when a failure held it back. */
  scanned_through?: string;
};

type GuidedDraftRequest = {
  purpose: EmailReplyPurpose;
  recipientName?: string;
  guidance: string;
  requiredFacts: string[];
  requiredVerbatim?: string[];
};

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function findExecutable(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
  }
  return candidates.at(-1) ?? "";
}

const GOG = findExecutable([
  process.env.GOG_BIN ?? "",
  path.join(os.homedir(), ".local", "bin", "gog"),
  "gog",
]);
const GWS = findExecutable([
  process.env.GWS_BIN ?? "",
  path.join(os.homedir(), ".npm-global", "bin", "gws"),
  "gws",
]);

async function command(
  executable: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const result = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 45_000,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function parseJson<T>(text: string): T {
  const trimmed = text.trim();
  if (!trimmed) return [] as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1)) as T;
    throw new Error("Command did not return valid JSON");
  }
}

function normalizeAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/u)?.[1];
  return (angle ?? value).trim().toLowerCase();
}

function displayName(value: string): string | undefined {
  const before = value
    .split("<", 1)[0]
    ?.replace(/^['"]|['"]$/gu, "")
    .trim();
  return before || undefined;
}

function firstName(message: EmailMessage): string {
  const candidate = message.fromName?.split(/\s+/u)[0] ?? message.from.split("@", 1)[0];
  return candidate.replace(/[^\p{L}\p{N}'-]/gu, "") || "there";
}

function allEmailAddresses(text: string): string[] {
  return [
    ...new Set(
      (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? []).map((x) => x.toLowerCase()),
    ),
  ];
}

export function authorizeClassification(
  message: EmailMessage,
  classification: ModelClassification,
  onboardingThread?: { candidate_email: string; decision: OnboardingDecision },
): Classification {
  const sender = normalizeAddress(message.from);
  if (classification.confidence < 0.8) {
    return {
      ...classification,
      category: "unknown",
      reason: `model confidence below automation threshold: ${classification.reason}`,
    };
  }
  if (classification.category === "onboarding_followup") {
    const tracked = onboardingThread;
    if (!tracked || sender !== tracked.candidate_email.toLowerCase()) {
      return {
        ...classification,
        category: "unknown",
        reason: "onboarding follow-up is not from the tracked candidate",
      };
    }
    return {
      ...classification,
      decision: tracked.decision,
      candidateEmail: sender,
    };
  }
  if (classification.category === "onboarding_instruction") {
    if (!onboardingSenders().has(sender)) {
      return {
        ...classification,
        category: "unknown",
        reason: "onboarding instruction is not from an authorized Gmail sender",
      };
    }
    if (!classification.decision || !classification.candidateEmail) {
      return {
        ...classification,
        category: "unknown",
        reason: "onboarding instruction is missing a decision or candidate email",
      };
    }
    return classification;
  }
  // A bcc closes a stage, and a closed stage stops the chase -- silently, because the failure is a
  // message that never gets sent. So it has to come from inside the lab. The roster check is done
  // by the caller (it needs the store); here we only refuse the obviously-outside case where the
  // sender is not a known address at all and the pass has no roster to consult.
  const privilegedCategory =
    classification.category === "calendar_event" ||
    classification.category === "reimbursement" ||
    classification.category === "talk_entry";
  if (privilegedCategory && !privilegedSenders().has(sender)) {
    return {
      ...classification,
      category: "unknown",
      reason: `${classification.category} request is not from an authorized Gmail sender`,
    };
  }
  return classification;
}

async function draftGuidedEmail(
  message: EmailMessage,
  model: AdminBotEmailModel,
  request: GuidedDraftRequest,
): Promise<ModelEmailDraft> {
  const draft = await model.draft(message, {
    purpose: request.purpose,
    recipientName: request.recipientName,
    guidance: request.guidance,
    requiredFacts: request.requiredFacts,
  });
  const allowedText = request.requiredFacts.join("\n");
  for (const value of request.requiredVerbatim ?? []) {
    if (!draft.body.includes(value)) {
      throw new Error(`generated ${request.purpose} email omitted required text: ${value}`);
    }
  }
  for (const url of draft.body.match(/https?:\/\/[^\s)>]+/gu) ?? []) {
    if (!allowedText.includes(url)) {
      throw new Error(`generated ${request.purpose} email introduced an unapproved link`);
    }
  }
  for (const email of allEmailAddresses(draft.body)) {
    if (!allowedText.toLowerCase().includes(email)) {
      throw new Error(`generated ${request.purpose} email introduced an unapproved address`);
    }
  }
  if (!draft.body.trimEnd().endsWith("Zhijing")) {
    throw new Error(`generated ${request.purpose} email omitted the required sender signature`);
  }
  return draft;
}
/**
 * Exported for the watermark tests. Whether the mailbox scan resumes is the difference between a
 * missed hour and a message nobody ever reads, so it is worth pinning without a Gmail account.
 */
export class StateStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS adminbot_email_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        subject TEXT,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        received_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adminbot_email_effects (
        message_id TEXT NOT NULL,
        effect_key TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(message_id, effect_key)
      );
      CREATE TABLE IF NOT EXISTS adminbot_onboarding_threads (
        thread_id TEXT PRIMARY KEY,
        candidate_email TEXT NOT NULL,
        decision TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adminbot_email_scan (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        scanned_through TEXT NOT NULL
      );
    `);
    ensureAdminBotEmailReviewSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * How far the mailbox has been read, as a point this pass may resume from.
   *
   * Undefined on a mailbox this box has never scanned, which the caller turns into the default
   * one-hour window rather than a first run that reads the whole archive.
   */
  scannedThrough(): Date | undefined {
    const row = this.db
      .prepare("SELECT scanned_through FROM adminbot_email_scan WHERE id = 1")
      .get() as { scanned_through?: string } | undefined;
    const at = row?.scanned_through ? Date.parse(row.scanned_through) : Number.NaN;
    return Number.isNaN(at) ? undefined : new Date(at);
  }

  /**
   * Move the watermark forward, never back.
   *
   * Only advanced by a pass that finished with nothing failed: a failure means some message in that
   * window has not been dealt with, and moving the mark past it is the silent drop this watermark
   * exists to stop. Monotonic because two passes overlapping -- a manual run beside the cron --
   * must not rewind the mailbox.
   */
  markScannedThrough(at: Date): void {
    const current = this.scannedThrough();
    if (current && current.getTime() >= at.getTime()) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO adminbot_email_scan (id, scanned_through) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET scanned_through=excluded.scanned_through`,
      )
      .run(at.toISOString());
  }

  /**
   * Whether this message has already reached a terminal state.
   *
   * Asked before the classifier rather than only inside `begin`, which is where the same question
   * used to be settled: the window can now overlap by design, so a message already dealt with must
   * cost a row lookup and not a 122B model call. `processing` and `failed` are deliberately not
   * settled -- both are retried, exactly as `begin` has always allowed.
   */
  isSettled(messageId: string): boolean {
    const row = this.db
      .prepare("SELECT status FROM adminbot_email_messages WHERE message_id = ?")
      .get(messageId) as { status?: string } | undefined;
    return (
      row?.status === "completed" || row?.status === "needs_review" || row?.status === "reviewed"
    );
  }

  getOnboarding(
    threadId: string,
  ): { candidate_email: string; decision: OnboardingDecision } | undefined {
    return this.db
      .prepare(
        "SELECT candidate_email, decision FROM adminbot_onboarding_threads WHERE thread_id = ? OR candidate_email = ?",
      )
      .get(threadId, threadId) as
      | { candidate_email: string; decision: OnboardingDecision }
      | undefined;
  }

  saveOnboarding(
    threadId: string,
    candidateEmail: string,
    decision: OnboardingDecision,
    sourceId: string,
  ): void {
    this.db
      .prepare(`INSERT INTO adminbot_onboarding_threads
      (thread_id, candidate_email, decision, source_message_id, status, updated_at)
      VALUES (?, ?, ?, ?, 'waiting', ?)
      ON CONFLICT(thread_id) DO UPDATE SET candidate_email=excluded.candidate_email,
        decision=excluded.decision, source_message_id=excluded.source_message_id,
        status='waiting', updated_at=excluded.updated_at`)
      .run(threadId, candidateEmail, decision, sourceId, new Date().toISOString());
  }

  // Takes a bare {category, reason} rather than a Classification: the recording-notice branch below
  // never consults the model, so it has no model classification to hand over.
  begin(message: EmailMessage, classification: { category: string; reason: string }): boolean {
    const existing = this.db
      .prepare("SELECT status FROM adminbot_email_messages WHERE message_id = ?")
      .get(message.id) as { status?: string } | undefined;
    if (
      existing?.status === "completed" ||
      existing?.status === "needs_review" ||
      existing?.status === "reviewed" ||
      existing?.status === "processing"
    )
      return false;
    this.db
      .prepare(`INSERT INTO adminbot_email_messages
      (message_id, thread_id, sender, subject, category, status, reason, attempts, received_at,
       updated_at)
      VALUES (?, ?, ?, ?, ?, 'processing', ?, 1, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET status='processing', category=excluded.category,
        thread_id=excluded.thread_id, sender=excluded.sender, subject=excluded.subject,
        reason=excluded.reason, received_at=COALESCE(excluded.received_at, received_at),
        attempts=adminbot_email_messages.attempts + 1, last_error=NULL,
        resolved_at=NULL, resolved_by=NULL, resolution=NULL, updated_at=excluded.updated_at`)
      .run(
        message.id,
        message.threadId,
        message.from,
        message.subject,
        classification.category,
        classification.reason,
        message.internalDate && Number.isFinite(Number(message.internalDate))
          ? new Date(Number(message.internalDate)).toISOString()
          : null,
        new Date().toISOString(),
      );
    return true;
  }

  finish(messageId: string, status: "completed" | "failed" | "needs_review", error?: string): void {
    this.db
      .prepare(
        "UPDATE adminbot_email_messages SET status=?, last_error=?, updated_at=? WHERE message_id=?",
      )
      .run(status, error ?? null, new Date().toISOString(), messageId);
  }

  async effect<T>(
    messageId: string,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    const existing = this.db
      .prepare(
        "SELECT status, result_json FROM adminbot_email_effects WHERE message_id=? AND effect_key=?",
      )
      .get(messageId, key) as { status: string; result_json?: string } | undefined;
    if (existing?.status === "completed")
      return existing.result_json ? (JSON.parse(existing.result_json) as T) : undefined;
    if (existing?.status === "started")
      throw new Error(`effect ${key} was started previously; manual review prevents a duplicate`);
    this.db
      .prepare(`INSERT INTO adminbot_email_effects(message_id,effect_key,status,updated_at)
      VALUES (?,?,'started',?) ON CONFLICT(message_id,effect_key) DO UPDATE SET status='started',updated_at=excluded.updated_at`)
      .run(messageId, key, new Date().toISOString());
    const result = await operation();
    this.db
      .prepare(
        "UPDATE adminbot_email_effects SET status='completed',result_json=?,updated_at=? WHERE message_id=? AND effect_key=?",
      )
      .run(JSON.stringify(result ?? null), new Date().toISOString(), messageId, key);
    return result;
  }
}

class GoogleClient {
  private args(args: string[]): string[] {
    return [...args, "--account", botEmail(), "--json", "--no-input"];
  }

  async search(since: Date): Promise<EmailMessage[]> {
    const result = await command(
      GOG,
      this.args([
        "gmail",
        "messages",
        "search",
        gmailScanQuery(since),
        "--max",
        "100",
        "--full",
        "--results-only",
      ]),
      { timeout: 60_000 },
    );
    const payload = parseJson<unknown>(result.stdout);
    const rows = Array.isArray(payload)
      ? payload
      : ((payload as { messages?: unknown[] })?.messages ??
        (payload as { results?: unknown[] })?.results ??
        []);
    return rows
      .map((row) => normalizeMessage(row))
      .filter((row): row is EmailMessage => Boolean(row));
  }

  async raw(messageId: string): Promise<Record<string, unknown>> {
    const result = await command(
      GOG,
      this.args(["gmail", "raw", messageId, "--format", "full", "--results-only"]),
    );
    return parseJson<Record<string, unknown>>(result.stdout);
  }

  async reply(messageId: string, body: string): Promise<unknown> {
    const result = await command(
      GOG,
      this.args(["gmail", "reply", messageId, "--body", body, "--no-quote"]),
    );
    return parseJson(result.stdout);
  }

  async send(
    to: string,
    subject: string,
    body: string,
    attachments: string[] = [],
  ): Promise<unknown> {
    const args = ["gmail", "send", "--to", to, "--subject", subject, "--body", body];
    // These bodies are model-drafted prose rather than template copy, so they carry no bullet
    // syntax -- but they hit the same delivery wrap, which turns a drafted paragraph into ragged
    // ~70-character lines. The renderer handles a paragraphs-only body fine.
    const html = renderEmailBodyHtml(body);
    if (html) {
      args.push("--body-html", html);
    }
    for (const attachment of attachments) args.push("--attach", attachment);
    const result = await command(GOG, this.args(args), { timeout: 60_000 });
    return parseJson(result.stdout);
  }

  async markRead(messageId: string): Promise<void> {
    await command(GOG, this.args(["gmail", "mark-read", messageId]));
  }

  /**
   * Create whichever outcome labels the mailbox does not have yet.
   *
   * Once per run, not once per message: labels are a property of the mailbox, and re-checking
   * three of them for every message would be forty API calls an hour to learn nothing. Gmail
   * rejects a duplicate label rather than returning the existing one, so this reads the list
   * first instead of creating blindly and swallowing the error -- swallowing it would also
   * swallow a genuine permissions failure, and then every file below would fail one at a time
   * with a confusing message.
   */
  async ensureOutcomeLabels(): Promise<void> {
    const result = await command(GOG, this.args(["gmail", "labels", "list", "--results-only"]));
    const payload = parseJson<unknown>(result.stdout);
    const rows = Array.isArray(payload)
      ? payload
      : ((payload as { labels?: unknown[] })?.labels ?? []);
    const existing = new Set(
      rows.flatMap((row) => {
        const name = row && typeof row === "object" ? (row as { name?: unknown }).name : undefined;
        return typeof name === "string" && name ? [name] : [];
      }),
    );
    for (const label of ALL_OUTCOME_LABELS) {
      if (existing.has(label)) {
        continue;
      }
      await command(GOG, this.args(["gmail", "labels", "create", label]));
    }
  }

  /**
   * File a message under its outcome.
   *
   * The other two outcome labels are always removed, so a message that failed last hour and was
   * handled this hour does not carry both. Only a completed message leaves the inbox: the whole
   * point is that what remains in the inbox is what still needs a person.
   */
  async file(messageId: string, outcome: EmailOutcome): Promise<void> {
    const { add, remove } = outcomeLabelChange(outcome);
    await command(
      GOG,
      this.args([
        "gmail",
        "messages",
        "modify",
        messageId,
        "--add",
        add.join(","),
        "--remove",
        remove.join(","),
      ]),
    );
  }

  async createEvent(event: CalendarEvent): Promise<unknown> {
    const args = [
      "calendar",
      "create",
      jinesisCalendar(),
      "--summary",
      event.summary,
      "--from",
      event.start,
      "--to",
      event.end,
      "--timezone",
      DEFAULT_TIMEZONE,
    ];
    if (event.allDay) args.push("--all-day");
    if (event.description) args.push("--description", event.description);
    if (event.location) args.push("--location", event.location);
    const result = await command(GOG, this.args(args));
    return parseJson(result.stdout);
  }

  async addCalendarReader(email: string): Promise<unknown> {
    const result = await command(
      GWS,
      [
        "calendar",
        "acl",
        "insert",
        "--params",
        JSON.stringify({ calendarId: jinesisCalendar(), sendNotifications: true }),
        "--json",
        JSON.stringify({ role: "reader", scope: { type: "user", value: email } }),
      ],
      { timeout: 45_000 },
    );
    return parseJson(result.stdout);
  }

  async downloadAttachments(message: EmailMessage, directory: string): Promise<string[]> {
    const raw = await this.raw(message.id);
    const parts = collectAttachmentParts(raw);
    const files: string[] = [];
    for (const [index, part] of parts.entries()) {
      const safeName = path.basename(part.filename || `attachment-${index + 1}`);
      const destination = path.join(directory, safeName);
      await command(
        GOG,
        this.args(["gmail", "attachment", message.id, part.attachmentId, "--out", destination]),
        {
          timeout: 60_000,
        },
      );
      files.push(destination);
    }
    return files;
  }
}

function normalizeMessage(value: unknown): EmailMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? row.messageId ?? "");
  if (!id) return undefined;
  const rawFrom = String(row.from ?? row.sender ?? headerValue(row, "From") ?? "");
  return {
    id,
    threadId: String(row.threadId ?? row.thread_id ?? id),
    from: normalizeAddress(rawFrom),
    fromName: displayName(rawFrom),
    subject: String(row.subject ?? headerValue(row, "Subject") ?? ""),
    body: String(row.body ?? row.text ?? row.snippet ?? ""),
    internalDate: row.internalDate ? String(row.internalDate) : undefined,
  };
}

function headerValue(row: Record<string, unknown>, name: string): unknown {
  const headers = (
    row.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined
  )?.headers;
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value;
}

function collectAttachmentParts(
  raw: Record<string, unknown>,
): Array<{ filename: string; attachmentId: string }> {
  const result: Array<{ filename: string; attachmentId: string }> = [];
  const visit = (part: unknown): void => {
    if (!part || typeof part !== "object") return;
    const item = part as Record<string, unknown>;
    const attachmentId = (item.body as { attachmentId?: string } | undefined)?.attachmentId;
    const filename = String(item.filename ?? "");
    if (attachmentId) result.push({ filename, attachmentId });
    for (const child of (item.parts as unknown[] | undefined) ?? []) visit(child);
  };
  visit(raw.payload ?? raw);
  return result;
}

async function extractCalendarEvent(
  message: EmailMessage,
  model: AdminBotEmailModel,
): Promise<CalendarEvent | undefined> {
  const event = await model.calendar(message);
  if (!event.summary || !event.start || !event.end) return undefined;
  return {
    ...event,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
  };
}

async function extractTalk(
  message: EmailMessage,
  model: AdminBotEmailModel,
): Promise<TalkEntry | undefined> {
  try {
    const talk = await model.talk(message, new Date().toISOString().slice(0, 10));
    return talk.title && talk.venue && talk.date ? talk : undefined;
  } catch {
    return undefined;
  }
}

export function formatTalkLatex(talk: TalkEntry): string {
  const prefix = talk.upcoming ? "(Upcoming) " : "";
  const context = [talk.venue, talk.location].filter(Boolean).join(", ");
  return `\\item \\cvtalk{${escapeLatex(talk.title)}}{${escapeLatex(prefix + context)}}{${escapeLatex(talk.date)}}`;
}

function escapeLatex(value: string): string {
  return value.replace(/([%$#&_{}])/gu, "\\$1");
}

async function extractText(files: string[]): Promise<string> {
  if (!files.length) return "";
  const helper = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "adminbot-reimbursement-from-email.py",
  );
  const result = await command("python3", [helper, "extract", ...files], { timeout: 90_000 });
  return result.stdout;
}

async function prepareReimbursement(
  message: EmailMessage,
  google: GoogleClient,
  directory: string,
  model: AdminBotEmailModel,
): Promise<string[]> {
  const attachments = await google.downloadAttachments(message, directory);
  const driveFiles = await downloadLinkedDriveFiles(
    `${message.subject}\n${message.body}`,
    directory,
  );
  const supportingFiles = [...new Set([...attachments, ...driveFiles])];
  const extracted = await extractText(supportingFiles);
  const data = await model.reimbursement(message, extracted);
  const missing = [
    ["claimant name", data.claimant_name],
    ["claimant email", data.claimant_email],
    ["claimant address", data.claimant_address],
    ["claimant title", data.claimant_title],
    ["travel period", data.travel_period || data.trip_dates],
    ["trip title", data.trip_title],
    ["trip location", data.trip_location],
    ["purpose", data.purpose],
  ]
    .filter(([, value]) => !String(value ?? "").trim())
    .map(([label]) => label);
  if (!data.expenses.length || data.expenses.every((expense) => expense.amount === 0)) {
    missing.push("at least one non-zero expense");
  }
  const requestedCurrency =
    data.currency === "OTHER" ? data.other_currency?.trim().toUpperCase() : data.currency;
  if (!requestedCurrency) {
    missing.push("requested reimbursement currency");
  }
  if (missing.length) {
    throw new Error(`reimbursement requires manual review; missing ${missing.join(", ")}`);
  }
  if (data.expenses.length > 30) {
    throw new Error(
      "reimbursement requires manual review; the Compute Expense Form supports at most 30 expense rows",
    );
  }
  const mismatchedCurrencies = data.expenses
    .map((expense) => expense.currency?.trim().toUpperCase())
    .filter((currency): currency is string => Boolean(currency && currency !== requestedCurrency));
  if (mismatchedCurrencies.length) {
    throw new Error(
      `reimbursement requires manual review; expense amounts must be converted to ${requestedCurrency} before the forms are filled`,
    );
  }
  const fillData = {
    ...data,
    prepared_date: new Date().toISOString().slice(0, 10),
    supporting_files: supportingFiles.map((file) => path.basename(file)),
  };
  const input = path.join(directory, "reimbursement.json");
  fs.writeFileSync(input, JSON.stringify(fillData, null, 2));
  const helper = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "adminbot-reimbursement-from-email.py",
  );
  const outputDir = path.join(directory, "forms");
  fs.mkdirSync(outputDir, { recursive: true });
  const result = await command("python3", [helper, "fill", input, outputDir], { timeout: 90_000 });
  const output = parseJson<{ files: string[] }>(result.stdout);
  return [...output.files, ...supportingFiles];
}

const SLACK_SECRET_FIELDS = ["botToken", "appToken", "userToken", "signingSecret"] as const;

async function resolveSlackSecretRefs(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<OpenClawConfig> {
  const resolvedConfig = structuredClone(sourceConfig);
  const slack = resolvedConfig.channels?.slack;
  if (!slack) return resolvedConfig;

  const entries: Array<Record<string, unknown>> = [
    slack as Record<string, unknown>,
    ...Object.values(slack.accounts ?? {}).map((account) => account as Record<string, unknown>),
  ];
  for (const entry of entries) {
    for (const field of SLACK_SECRET_FIELDS) {
      if (entry[field] === undefined) continue;
      const value = await resolveSecretInputString({
        config: sourceConfig,
        value: entry[field],
        env,
      });
      if (value) entry[field] = value;
      else delete entry[field];
    }
  }
  return resolvedConfig;
}

export async function resolveEmailAutomationSlackAccount(
  params: {
    cfg?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const sourceConfig = params.cfg ?? loadConfig({ skipPluginValidation: true });
  const resolvedConfig = await resolveSlackSecretRefs(sourceConfig, params.env ?? process.env);
  return resolveSlackAccount({ cfg: resolvedConfig });
}

async function inviteTrial(email: string): Promise<unknown> {
  const account = await resolveEmailAutomationSlackAccount();
  if (!account.botToken) throw new Error("Slack bot token is not configured");
  return getSlackWriteClient(account.botToken).apiCall("conversations.inviteShared", {
    channel: slackChannel(),
    emails: [email],
    external_limited: true,
  });
}

async function inviteFullMember(email: string): Promise<unknown> {
  const account = await resolveEmailAutomationSlackAccount();
  if (!account.userToken) throw new Error("Slack user token is required for admin.users.invite");
  const client = getSlackWriteClient(account.userToken);
  const auth = await client.auth.test();
  const teamId = auth.team_id;
  if (!teamId) throw new Error("Slack auth.test did not return a team_id");
  return client.apiCall("admin.users.invite", {
    team_id: teamId,
    email,
    channel_ids: [slackChannel()],
  });
}

function extractResultThreadId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const row = result as Record<string, unknown>;
  return (
    String(
      row.threadId ??
        row.thread_id ??
        (row.message as Record<string, unknown> | undefined)?.threadId ??
        "",
    ) || undefined
  );
}

/**
 * Close the PaperFlow stage a bcc'd venue mail proves has happened.
 *
 * Three gates before anything is written, in cheapening order: the sender has to be somebody in
 * the lab, the model has to pick a paper out of the closed candidate set, and the pick has to
 * survive being re-checked against that set. Failing any of them raises "queued for review",
 * which the caller turns into a needs-review label rather than a failure -- an unmatched bcc is
 * not an error, it is a message a human should glance at.
 */
async function recordPaperflowBcc(
  message: EmailMessage,
  model: AdminBotEmailModel,
  databasePath: string,
): Promise<{ paperId: string; stage: string; confidence: number }> {
  const { service, store, close } = createAdminBotSqliteService({ databasePath });
  try {
    const sender = normalizeAddress(message.from);
    const known = store
      .listLabMembers()
      .some((member) =>
        [member.email, member.calendar_email, member.correspondence_email]
          .filter((address): address is string => Boolean(address))
          .some((address) => address.trim().toLowerCase() === sender),
      );
    if (!known && !privilegedSenders().has(sender)) {
      throw new Error(
        `paperflow bcc from ${sender} is not a lab address; queued for review rather than closing a stage`,
      );
    }

    const open = service.collectPaperflowStageNudges();
    if (!open.ok) {
      throw new Error(open.error.message);
    }
    const candidates: PaperflowCandidate[] = open.payload.items.map((item) => {
      const paper = store.getPaper(item.paper_id);
      const submissionId = store
        .listPaperSlots(item.paper_id)
        .find((row) => row.slot === "submission_id" && row.status === "provided")?.value_text;
      const candidate: PaperflowCandidate = {
        paperId: item.paper_id,
        title: item.title,
        openStage: item.stage,
        authors: paper?.authors ?? [],
      };
      // The venue name and the submission id are the two strongest signals the matcher has after
      // the title, so they are attached when the lab has them and left off when it does not --
      // an empty string would read as "this paper has no venue" rather than "we never recorded it".
      if (item.venue) {
        candidate.venue = item.venue;
      }
      if (submissionId) {
        candidate.submissionId = submissionId;
      }
      return candidate;
    });

    const match = await model.paperflowEvidence(message, candidates);
    if (!match.paperId || !match.stage) {
      throw new Error(`paperflow bcc matched no open paper (${match.reason}); queued for review`);
    }
    // The model was constrained to this set, but a constrained decode is a strong hint rather than
    // a guarantee, and the cost of trusting it wrongly is a paper nobody chases again.
    const candidate = candidates.find((entry) => entry.paperId === match.paperId);
    if (!candidate) {
      throw new Error(
        `paperflow bcc named a paper that has no open stage (${match.paperId}); queued for review`,
      );
    }
    // Held before the guard narrows it: after the narrowing the name is unavailable to quote back,
    // and "that is not a stage" is only useful if it says which one was meant.
    const namedStage: string = match.stage;
    if (!isAdminBotPaperflowStage(match.stage)) {
      throw new Error(`${namedStage} is not a PaperFlow stage; queued for review`);
    }
    if (match.stage !== candidate.openStage) {
      throw new Error(
        `paperflow bcc named ${namedStage} but ${candidate.title} is waiting on ${candidate.openStage}; queued for review`,
      );
    }
    if (match.confidence < adminBotPaperflowEvidenceMinConfidence) {
      throw new Error(
        `paperflow bcc match was only ${Math.round(match.confidence * 100)}% confident on ${candidate.title}; queued for review`,
      );
    }

    const recorded = service.recordPaperflowEvidence({
      paperId: match.paperId,
      stage: match.stage,
      messageId: message.id,
      subject: message.subject,
      sender,
      confidence: match.confidence,
      recordedBy: "email_bcc",
      actor: "email_automation",
    });
    if (!recorded.ok) {
      throw new Error(recorded.error.message);
    }
    return { paperId: match.paperId, stage: match.stage, confidence: match.confidence };
  } finally {
    close();
  }
}

async function processMessage(
  message: EmailMessage,
  classification: Classification,
  state: StateStore,
  google: GoogleClient,
  model: AdminBotEmailModel,
  databasePath: string,
): Promise<boolean> {
  if (!state.begin(message, classification)) return false;
  try {
    if (classification.category === "unknown") {
      state.finish(message.id, "needs_review", classification.reason);
      return true;
    }
    if (classification.category === "student_reachout") {
      const draft = await draftGuidedEmail(message, model, {
        purpose: "student_outreach",
        recipientName: firstName(message),
        guidance:
          "Acknowledge specific stated interests, explain that project matching happens through the application form, and invite an application without promising a position.",
        requiredFacts: [
          `The application form is ${APPLICATION_FORM}.`,
          "Submitting the form lets the lab match interests and skills to suitable projects.",
        ],
        requiredVerbatim: [APPLICATION_FORM],
      });
      await state.effect(message.id, "student_reply", () => google.reply(message.id, draft.body));
    } else if (classification.category === "onboarding_instruction") {
      const email = classification.candidateEmail;
      if (!email || !classification.decision) {
        throw new Error("trusted onboarding email is missing a candidate email or decision");
      }
      if (classification.decision === "trial") {
        await state.effect(message.id, "slack_connect", () => inviteTrial(email));
        await state.effect(message.id, "calendar_reader", () => google.addCalendarReader(email));
      } else if (classification.decision === "direct") {
        const draft = await draftGuidedEmail(message, model, {
          purpose: "direct_onboarding",
          recipientName: classification.candidateName ?? undefined,
          guidance:
            "Welcome the candidate and clearly sequence the department-email, reply, Slack, calendar, and member-account onboarding steps.",
          requiredFacts: [
            `The recipient is ${email}.`,
            `Create a @cs.toronto.edu account through ${DCS_FORM}.`,
            `Send the new @cs.toronto.edu address from this same mailbox — reply to this thread, or email ${botEmail()} — before the full Slack invitation is sent.`,
            "The Slack invitation is issued automatically on that reply; no lab admin has to be emailed.",
            `Create a member account at ${CONTROL_UI_URL} and work through the onboarding guide there.`,
            "Calendar access is part of onboarding.",
          ],
          requiredVerbatim: [DCS_FORM, "@cs.toronto.edu", botEmail(), CONTROL_UI_ORIGIN],
        });
        const sent = await state.effect(message.id, "direct_instructions", () =>
          google.send(email, draft.subject, draft.body),
        );
        const threadId = extractResultThreadId(sent) ?? message.threadId;
        state.saveOnboarding(threadId, email, "direct", message.id);
        await state.effect(message.id, "calendar_reader", () => google.addCalendarReader(email));
      } else {
        const draft = await draftGuidedEmail(message, model, {
          purpose: "decline_candidate",
          recipientName: classification.candidateName ?? undefined,
          guidance:
            "Politely communicate the decline, thank the candidate, avoid unsupported evaluation details, and do not imply a future offer.",
          requiredFacts: [
            `The recipient is ${email}.`,
            "The lab is not offering a position at this time.",
          ],
        });
        await state.effect(message.id, "decline_email", () =>
          google.send(email, draft.subject, draft.body),
        );
      }
    } else if (classification.category === "onboarding_followup") {
      const addresses = [normalizeAddress(message.from), ...allEmailAddresses(message.body)];
      const dcs = addresses.find((email) => email.endsWith("@cs.toronto.edu"));
      if (!dcs) {
        const draft = await draftGuidedEmail(message, model, {
          purpose: "request_department_email",
          recipientName: firstName(message),
          guidance:
            "Explain the remaining department-account dependency and ask for a reply in this thread after the address is ready.",
          requiredFacts: [
            "The department sends the account-creation instructions.",
            `The candidate must send the new @cs.toronto.edu address from this same mailbox, in this thread or to ${botEmail()}.`,
            "The full Slack invitation is issued automatically after that reply; no lab admin has to be emailed.",
          ],
          requiredVerbatim: ["@cs.toronto.edu", botEmail()],
        });
        await state.effect(message.id, "request_dcs_email", () =>
          google.reply(message.id, draft.body),
        );
      } else {
        await state.effect(message.id, "full_slack_invite", () => inviteFullMember(dcs));
        await state.effect(message.id, "calendar_reader_dcs", () => google.addCalendarReader(dcs));
        const draft = await draftGuidedEmail(message, model, {
          purpose: "confirm_onboarding",
          recipientName: firstName(message),
          guidance:
            "Confirm completion concisely, state which address received the Slack invitation and calendar access, and point at the member account as the remaining step.",
          requiredFacts: [
            `The full Jinesis AI Lab Slack invitation was sent to ${dcs}.`,
            `Calendar reader access was granted to ${dcs}.`,
            `The remaining step is to create a member account at ${CONTROL_UI_URL} and follow the onboarding guide there.`,
          ],
          requiredVerbatim: [dcs, CONTROL_UI_ORIGIN],
        });
        await state.effect(message.id, "onboarding_complete_reply", () =>
          google.reply(message.id, draft.body),
        );
      }
    } else if (classification.category === "calendar_event") {
      const event = await extractCalendarEvent(message, model);
      if (!event) throw new Error("calendar request is missing a parseable event title or date");
      await state.effect(message.id, "calendar_create", () => google.createEvent(event));
    } else if (classification.category === "talk_entry") {
      if (!privilegedSenders().has(normalizeAddress(message.from))) {
        throw new Error("talk-entry automation requires a trusted sender; queued for review");
      }
      const talk = await extractTalk(message, model);
      if (!talk) throw new Error("talk email is missing title, venue, or date");
      const latex = formatTalkLatex(talk);
      const draft = await draftGuidedEmail(message, model, {
        purpose: "deliver_talk_entry",
        guidance:
          "Tell the administrator the CV entry is ready, preserve the LaTeX line exactly, and identify the source thread without adding unsupported details.",
        requiredFacts: [
          `Deliver this exact LaTeX line: ${latex}`,
          `The source thread subject is ${message.subject}.`,
          `The recipient is ${adminRecipient()}.`,
        ],
        requiredVerbatim: [latex],
      });
      await state.effect(message.id, "send_talk_entry", () =>
        google.send(adminRecipient(), draft.subject, draft.body),
      );
    } else if (classification.category === "reimbursement") {
      if (!privilegedSenders().has(normalizeAddress(message.from))) {
        throw new Error("reimbursement automation requires a trusted sender; queued for review");
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-reimbursement-"));
      const files = await prepareReimbursement(message, google, directory, model);
      const draft = await draftGuidedEmail(message, model, {
        purpose: "deliver_reimbursement",
        guidance:
          "Explain that both completed reimbursement forms and all source receipts are attached and identify the fields requiring human review before submission.",
        requiredFacts: [
          `The source thread subject is ${message.subject}.`,
          "The completed Compute Expense Form, completed Trip Summary Form, and all supporting receipt files are attached.",
          "Funding source and signature fields were intentionally left for human review.",
          `The recipient is ${adminRecipient()}.`,
        ],
      });
      await state.effect(message.id, "send_reimbursement", () =>
        google.send(adminRecipient(), draft.subject, draft.body, files),
      );
    } else if (classification.category === "paperflow_bcc") {
      // No reply and no acknowledgement. The author was told bcc'ing is all that is needed, and a
      // robot writing back "thanks, noted" to every forwarded decision is how people start
      // filtering the address they were asked to bcc.
      await state.effect(message.id, "paperflow_evidence", () =>
        recordPaperflowBcc(message, model, databasePath),
      );
    }
    await state.effect(message.id, "mark_read", () => google.markRead(message.id));
    state.finish(message.id, "completed");
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    state.finish(
      message.id,
      reason.includes("manual review") || reason.includes("queued for review")
        ? "needs_review"
        : "failed",
      reason,
    );
    throw error;
  }
}
/**
 * File a forwarded Zoom recording notice, without consulting the model.
 *
 * This runs before classification for two reasons. The classifier has no category for a recording
 * notice, so every one of them would land in the needs-review pile a human is supposed to read.
 * And the notice is already structured -- topic, time, link, passcode on labelled lines -- so
 * spending a 122B model on it would be slower, more expensive and less reliable than a regex.
 *
 * Returns false when the mail turns out not to be a notice after all, so the caller falls through
 * to the normal path rather than swallowing the message.
 */
function fileRecordingNotice(
  message: EmailMessage,
  state: StateStore,
  databasePath: string,
): boolean {
  const meeting = noticeToMeeting({
    id: message.id,
    subject: message.subject,
    body: message.body,
    receivedAt: message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : new Date().toISOString(),
  });
  if (!meeting) {
    return false;
  }
  if (
    !state.begin(message, { category: "meeting_recording", reason: "Zoom cloud recording notice" })
  ) {
    return true;
  }
  const { service, close } = createAdminBotSqliteService({ databasePath });
  try {
    const result = service.upsertMeeting(meeting);
    state.finish(
      message.id,
      result.ok ? "completed" : "needs_review",
      result.ok ? undefined : result.error.message,
    );
  } finally {
    close();
  }
  return true;
}

export async function runEmailAutomation(): Promise<EmailAutomationSummary> {
  loadDotEnv(path.join(os.homedir(), ".openclaw", ".env"));
  process.env.GOG_ACCOUNT = botEmail();
  const databasePath =
    process.env.ADMINBOT_DB_PATH ??
    path.join(os.homedir(), ".openclaw", "state", "adminbot.sqlite");
  const state = new StateStore(databasePath);
  const google = new GoogleClient();
  const model = new AdminBotEmailModel();
  const summary: EmailAutomationSummary = {
    found: 0,
    completed: 0,
    failed: 0,
    needs_review: 0,
    skipped: 0,
    errors: [],
  };
  const runStart = new Date();
  // Where this pass starts reading: the watermark when there is one, an hour back when there is
  // not. gmailScanQuery clamps how far back a long outage may reach.
  const since =
    state.scannedThrough() ?? new Date(runStart.getTime() - GMAIL_SCAN_DEFAULT_LOOKBACK_MS);
  try {
    const messages = await google.search(since);
    summary.found = messages.length;
    summary.scanned_since = since.toISOString();
    // Nothing to file if nothing arrived, and an empty hour is most hours -- so the label check
    // is skipped rather than run on a pass that will not use it.
    if (messages.length > 0) {
      await google.ensureOutcomeLabels();
    }
    // Filing is the last thing that happens to a message, whatever path it took, so it lives here
    // rather than in each branch. Its own failure is recorded and swallowed: a message that was
    // genuinely handled must not be reported as failed because a label could not be written, and
    // the label is a filing aid rather than part of the work.
    const file = async (messageId: string, outcome: EmailOutcome): Promise<void> => {
      try {
        await state.effect(messageId, `file_${outcome}`, () => google.file(messageId, outcome));
      } catch (error) {
        summary.errors.push(
          `${messageId}: could not file as ${outcome}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    for (const message of messages) {
      // Already dealt with on an earlier pass. The window overlaps on purpose now, so this is the
      // common case for most of what a resumed scan returns -- and it has to cost a row lookup
      // rather than a classification, or a catching-up pass would re-bill the model for a week of
      // settled mail.
      if (state.isSettled(message.id)) {
        summary.skipped += 1;
        continue;
      }
      // Deterministic branch first: a recording notice is machine-readable and must never reach
      // the classifier, which would file it as unknown and park it for a human.
      if (looksLikeZoomRecordingNotice(message.subject, message.body)) {
        try {
          if (fileRecordingNotice(message, state, databasePath)) {
            const outcome = state.db
              .prepare("SELECT status FROM adminbot_email_messages WHERE message_id=?")
              .get(message.id) as { status?: string } | undefined;
            if (outcome?.status === "needs_review") {
              summary.needs_review += 1;
              await file(message.id, "needs_review");
            } else {
              summary.completed += 1;
              await file(message.id, "completed");
            }
            continue;
          }
        } catch (error) {
          summary.failed += 1;
          summary.errors.push(
            `${message.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await file(message.id, "failed");
          continue;
        }
      }
      const onboarding =
        state.getOnboarding(message.threadId) ??
        state.getOnboarding(normalizeAddress(message.from));
      try {
        const modelClassification = await model.classify(message, onboarding);
        const classification = authorizeClassification(message, modelClassification, onboarding);
        const processed = await processMessage(
          message,
          classification,
          state,
          google,
          model,
          databasePath,
        );
        if (!processed) {
          // Already handled on an earlier pass, so it already carries its label. Re-filing it
          // would be a second write saying the same thing.
          summary.skipped += 1;
          continue;
        }
        const status = state.db
          .prepare("SELECT status FROM adminbot_email_messages WHERE message_id=?")
          .get(message.id) as { status?: string } | undefined;
        if (status?.status === "completed") {
          summary.completed += 1;
          await file(message.id, "completed");
        }
        if (status?.status === "needs_review") {
          summary.needs_review += 1;
          await file(message.id, "needs_review");
        }
      } catch (error) {
        const status = state.db
          .prepare("SELECT status FROM adminbot_email_messages WHERE message_id=?")
          .get(message.id) as { status?: string } | undefined;
        if (status?.status === "needs_review") {
          summary.needs_review += 1;
          await file(message.id, "needs_review");
        } else {
          summary.failed += 1;
          summary.errors.push(
            `${message.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await file(message.id, "failed");
        }
      }
    }
    // Only a pass that dealt with everything it found may move the watermark. A failure left in the
    // window is a message that still has to be seen again, and advancing past it is exactly the
    // silent drop this is here to stop. The mark is the moment the scan *started*, so mail that
    // landed while the pass was running is read by the next one rather than skipped.
    if (summary.failed === 0) {
      state.markScannedThrough(runStart);
      summary.scanned_through = runStart.toISOString();
    }
  } finally {
    state.close();
  }
  return summary;
}
if (isMainModule(import.meta.url)) {
  void runEmailAutomation()
    .then((summary) => {
      console.log(JSON.stringify(summary));
      if (summary.failed > 0 && process.env.ADMINBOT_EMAIL_ALLOW_PARTIAL !== "1") {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
