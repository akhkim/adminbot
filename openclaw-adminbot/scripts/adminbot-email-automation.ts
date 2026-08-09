#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { renderEmailBodyHtml } from "../extensions/adminbot/api.js";
import { getSlackWriteClient, resolveSlackAccount } from "../extensions/slack/api.js";
import { loadConfig } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { resolveSecretInputString } from "../src/secrets/resolve-secret-input-string.js";
import { downloadLinkedDriveFiles } from "./adminbot-drive-download.js";
import {
  AdminBotEmailModel,
  gmailOneHourQuery,
  type EmailReplyPurpose,
  type ModelClassification,
  type ModelEmailDraft,
} from "./adminbot-email-model.js";

const execFileAsync = promisify(execFile);
const ACCOUNT = "jinesis.adminbot@gmail.com";
const JINESIS_CALENDAR = "jinesis.lab@gmail.com";
const ADMIN_RECIPIENT = "andrewkihyun@gmail.com";
const SLACK_CHANNEL = "C09MANEUPPZ";
const ONBOARDING_SENDERS = new Set(["zjin@cs.toronto.edu", "zjin.admin@cs.toronto.edu"]);
const PRIVILEGED_SENDERS = new Set([...ONBOARDING_SENDERS, "andrewkihyun@gmail.com"]);
const APPLICATION_FORM =
  "https://docs.google.com/forms/d/e/1FAIpQLSdyRYBiLPFUaaUC5v4ATIUwQpYPgmjRja33qwZFvH6BoIRCAA/viewform";
const DCS_FORM = "https://forms.office.com/r/TgGWBGWLZa";
// Onboarding emails cite the launch URL, but `requiredVerbatim` matches the origin: the model writes
// the link with or without the trailing slash, and the origin is a prefix of both renderings.
const CONTROL_UI_URL = "https://jinesis-admin.vercel.app/";
const CONTROL_UI_ORIGIN = "https://jinesis-admin.vercel.app";
const DEFAULT_TIMEZONE = "America/Toronto";

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
    if (!ONBOARDING_SENDERS.has(sender)) {
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
  const privilegedCategory =
    classification.category === "calendar_event" ||
    classification.category === "reimbursement" ||
    classification.category === "talk_entry";
  if (privilegedCategory && !PRIVILEGED_SENDERS.has(sender)) {
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
class StateStore {
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
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
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
    `);
  }

  close(): void {
    this.db.close();
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

  begin(message: EmailMessage, classification: Classification): boolean {
    const existing = this.db
      .prepare("SELECT status FROM adminbot_email_messages WHERE message_id = ?")
      .get(message.id) as { status?: string } | undefined;
    if (
      existing?.status === "completed" ||
      existing?.status === "needs_review" ||
      existing?.status === "processing"
    )
      return false;
    this.db
      .prepare(`INSERT INTO adminbot_email_messages
      (message_id, thread_id, sender, category, status, reason, attempts, updated_at)
      VALUES (?, ?, ?, ?, 'processing', ?, 1, ?)
      ON CONFLICT(message_id) DO UPDATE SET status='processing', category=excluded.category,
        reason=excluded.reason, attempts=adminbot_email_messages.attempts + 1,
        last_error=NULL, updated_at=excluded.updated_at`)
      .run(
        message.id,
        message.threadId,
        message.from,
        classification.category,
        classification.reason,
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
    return [...args, "--account", ACCOUNT, "--json", "--no-input"];
  }

  async search(): Promise<EmailMessage[]> {
    const result = await command(
      GOG,
      this.args([
        "gmail",
        "messages",
        "search",
        gmailOneHourQuery(),
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

  // Gmail's trash, not a permanent delete: a wrongly handled message is still
  // recoverable from the bin for 30 days.
  async trash(messageId: string): Promise<void> {
    await command(GOG, this.args(["gmail", "trash", messageId]));
  }

  async createEvent(event: CalendarEvent): Promise<unknown> {
    const args = [
      "calendar",
      "create",
      JINESIS_CALENDAR,
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
        JSON.stringify({ calendarId: JINESIS_CALENDAR, sendNotifications: true }),
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
    channel: SLACK_CHANNEL,
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
    channel_ids: [SLACK_CHANNEL],
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

async function processMessage(
  message: EmailMessage,
  classification: Classification,
  state: StateStore,
  google: GoogleClient,
  model: AdminBotEmailModel,
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
            `Send the new @cs.toronto.edu address from this same mailbox — reply to this thread, or email ${ACCOUNT} — before the full Slack invitation is sent.`,
            "The Slack invitation is issued automatically on that reply; no lab admin has to be emailed.",
            `Create a member account at ${CONTROL_UI_URL} and work through the onboarding guide there.`,
            "Calendar access is part of onboarding.",
          ],
          requiredVerbatim: [DCS_FORM, "@cs.toronto.edu", ACCOUNT, CONTROL_UI_ORIGIN],
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
            `The candidate must send the new @cs.toronto.edu address from this same mailbox, in this thread or to ${ACCOUNT}.`,
            "The full Slack invitation is issued automatically after that reply; no lab admin has to be emailed.",
          ],
          requiredVerbatim: ["@cs.toronto.edu", ACCOUNT],
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
      if (!PRIVILEGED_SENDERS.has(normalizeAddress(message.from))) {
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
          `The recipient is ${ADMIN_RECIPIENT}.`,
        ],
        requiredVerbatim: [latex],
      });
      await state.effect(message.id, "send_talk_entry", () =>
        google.send(ADMIN_RECIPIENT, draft.subject, draft.body),
      );
    } else if (classification.category === "reimbursement") {
      if (!PRIVILEGED_SENDERS.has(normalizeAddress(message.from))) {
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
          `The recipient is ${ADMIN_RECIPIENT}.`,
        ],
      });
      await state.effect(message.id, "send_reimbursement", () =>
        google.send(ADMIN_RECIPIENT, draft.subject, draft.body, files),
      );
    }
    await state.effect(message.id, "mark_read", () => google.markRead(message.id));
    // Only fully handled messages are deleted, and only after every other
    // effect landed. Anything that failed or went to needs_review returns
    // through the catch below and stays in the inbox for a human.
    await state.effect(message.id, "trash", () => google.trash(message.id));
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
export async function runEmailAutomation(): Promise<EmailAutomationSummary> {
  loadDotEnv(path.join(os.homedir(), ".openclaw", ".env"));
  process.env.GOG_ACCOUNT = ACCOUNT;
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
  try {
    const messages = await google.search();
    summary.found = messages.length;
    for (const message of messages) {
      const onboarding =
        state.getOnboarding(message.threadId) ??
        state.getOnboarding(normalizeAddress(message.from));
      try {
        const modelClassification = await model.classify(message, onboarding);
        const classification = authorizeClassification(message, modelClassification, onboarding);
        const processed = await processMessage(message, classification, state, google, model);
        if (!processed) {
          summary.skipped += 1;
          continue;
        }
        const status = state.db
          .prepare("SELECT status FROM adminbot_email_messages WHERE message_id=?")
          .get(message.id) as { status?: string } | undefined;
        if (status?.status === "completed") summary.completed += 1;
        if (status?.status === "needs_review") summary.needs_review += 1;
      } catch (error) {
        const status = state.db
          .prepare("SELECT status FROM adminbot_email_messages WHERE message_id=?")
          .get(message.id) as { status?: string } | undefined;
        if (status?.status === "needs_review") {
          summary.needs_review += 1;
        } else {
          summary.failed += 1;
          summary.errors.push(
            `${message.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } finally {
    state.close();
  }
  return summary;
}
if (import.meta.url === `file://${process.argv[1]}`) {
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
