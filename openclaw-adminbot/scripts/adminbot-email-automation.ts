#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { getSlackWriteClient, resolveSlackAccount } from "../extensions/slack/api.js";
import { loadConfig } from "../src/config/config.js";
import { downloadLinkedDriveFiles } from "./adminbot-drive-download.js";
import {
  AdminBotEmailModel,
  gmailOneHourQuery,
  type ModelClassification,
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

export function studentReply(message: EmailMessage): string {
  return `Hi ${firstName(message)},

Thank you for reaching out! Your interests look relevant to our research. I usually match students to projects through the application form on my personal website's Openings page:

${APPLICATION_FORM}

You're welcome to fill out the form, and I'll get in touch when there is a suitable project based on your description of your interests and skills.

Looking forward to seeing your application!

Best,
Zhijing`;
}

export function directOnboardingEmail(name?: string): string {
  return `Hi ${name?.trim() || "there"},

Welcome to the Jinesis AI Lab! Please complete the following steps:

1. Create a @cs.toronto.edu email through ${DCS_FORM}
2. Reply to this email with your newly created @cs.toronto.edu email
3. Join the Slack workspace through the invitation email that will follow

We will also add you to the lab calendar and the other lab services as they become available.

Best,
Zhijing`;
}

export function declineEmail(name?: string): string {
  return `Hi ${name?.trim() || "there"},

Thank you very much for your interest and for taking the time to speak with us. Unfortunately, we could not find a strong fit between your expertise and the projects currently underway in the lab.

I'm sorry that we cannot offer a position at this time, and I wish you the very best in finding another opportunity.

Best,
Zhijing`;
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
    for (const attachment of attachments) args.push("--attach", attachment);
    const result = await command(GOG, this.args(args), { timeout: 60_000 });
    return parseJson(result.stdout);
  }

  async markRead(messageId: string): Promise<void> {
    await command(GOG, this.args(["gmail", "mark-read", messageId]));
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
  const supportingFiles = [...attachments, ...driveFiles];
  const extracted = await extractText(supportingFiles);
  const data = await model.reimbursement(message, extracted);
  if (!data.claimant_name || !data.purpose || !data.expenses.length) {
    throw new Error(
      "reimbursement email does not contain enough claimant, purpose, and expense information",
    );
  }
  const input = path.join(directory, "reimbursement.json");
  fs.writeFileSync(input, JSON.stringify(data, null, 2));
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

async function inviteTrial(email: string): Promise<unknown> {
  const account = resolveSlackAccount({ cfg: loadConfig({ skipPluginValidation: true }) });
  if (!account.botToken) throw new Error("Slack bot token is not configured");
  return getSlackWriteClient(account.botToken).apiCall("conversations.inviteShared", {
    channel: SLACK_CHANNEL,
    emails: [email],
    external_limited: true,
  });
}

async function inviteFullMember(email: string): Promise<unknown> {
  const account = resolveSlackAccount({ cfg: loadConfig({ skipPluginValidation: true }) });
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
): Promise<void> {
  if (!state.begin(message, classification)) return;
  try {
    if (classification.category === "unknown") {
      state.finish(message.id, "needs_review", classification.reason);
      return;
    }
    if (classification.category === "student_reachout") {
      await state.effect(message.id, "student_reply", () =>
        google.reply(message.id, studentReply(message)),
      );
    } else if (classification.category === "onboarding_instruction") {
      const email = classification.candidateEmail;
      if (!email || !classification.decision)
        throw new Error("trusted onboarding email is missing a candidate email or decision");
      if (classification.decision === "trial") {
        await state.effect(message.id, "slack_connect", () => inviteTrial(email));
        await state.effect(message.id, "calendar_reader", () => google.addCalendarReader(email));
      } else if (classification.decision === "direct") {
        const sent = await state.effect(message.id, "direct_instructions", () =>
          google.send(
            email,
            "Welcome to the Jinesis AI Lab - onboarding steps",
            directOnboardingEmail(classification.candidateName ?? undefined),
          ),
        );
        const threadId = extractResultThreadId(sent) ?? message.threadId;
        state.saveOnboarding(threadId, email, "direct", message.id);
        await state.effect(message.id, "calendar_reader", () => google.addCalendarReader(email));
      } else {
        await state.effect(message.id, "decline_email", () =>
          google.send(
            email,
            "Jinesis AI Lab research application",
            declineEmail(classification.candidateName ?? undefined),
          ),
        );
      }
    } else if (classification.category === "onboarding_followup") {
      const addresses = [normalizeAddress(message.from), ...allEmailAddresses(message.body)];
      const dcs = addresses.find((email) => email.endsWith("@cs.toronto.edu"));
      if (!dcs) {
        await state.effect(message.id, "request_dcs_email", () =>
          google.reply(
            message.id,
            `Thank you. The department will send you an email with instructions to create your @cs.toronto.edu address. Please reply here with that new address once it is ready, and we will send the full Slack invitation.\n\nBest,\nZhijing`,
          ),
        );
      } else {
        await state.effect(message.id, "full_slack_invite", () => inviteFullMember(dcs));
        await state.effect(message.id, "calendar_reader_dcs", () => google.addCalendarReader(dcs));
        await state.effect(message.id, "onboarding_complete_reply", () =>
          google.reply(
            message.id,
            `Thank you! Your full Jinesis AI Lab Slack invitation has been sent to ${dcs}.\n\nBest,\nZhijing`,
          ),
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
      await state.effect(message.id, "send_talk_entry", () =>
        google.send(
          ADMIN_RECIPIENT,
          `CV talk entry: ${talk.title}`,
          `Generated from email thread \"${message.subject}\":\n\n${latex}`,
        ),
      );
    } else if (classification.category === "reimbursement") {
      if (!PRIVILEGED_SENDERS.has(normalizeAddress(message.from))) {
        throw new Error("reimbursement automation requires a trusted sender; queued for review");
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-reimbursement-"));
      const files = await prepareReimbursement(message, google, directory, model);
      await state.effect(message.id, "send_reimbursement", () =>
        google.send(
          ADMIN_RECIPIENT,
          `Prepared reimbursement forms: ${message.subject}`,
          `Attached are the reimbursement forms and supporting files prepared from the email thread \"${message.subject}\". Please review the funding source and signature fields before submission.`,
          files,
        ),
      );
    }
    await state.effect(message.id, "mark_read", () => google.markRead(message.id));
    state.finish(message.id, "completed");
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

async function main(): Promise<void> {
  loadDotEnv(path.join(os.homedir(), ".openclaw", ".env"));
  process.env.GOG_ACCOUNT = ACCOUNT;
  const databasePath =
    process.env.ADMINBOT_DB_PATH ??
    path.join(os.homedir(), ".openclaw", "state", "adminbot.sqlite");
  const state = new StateStore(databasePath);
  const google = new GoogleClient();
  const model = new AdminBotEmailModel();
  const summary = { found: 0, completed: 0, failed: 0, needs_review: 0, errors: [] as string[] };
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
        await processMessage(message, classification, state, google, model);
        const status = state.db
          .prepare("SELECT status FROM adminbot_email_messages WHERE message_id=?")
          .get(message.id) as { status?: string } | undefined;
        if (status?.status === "completed") summary.completed += 1;
        if (status?.status === "needs_review") summary.needs_review += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(
          `${message.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    state.close();
  }
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
