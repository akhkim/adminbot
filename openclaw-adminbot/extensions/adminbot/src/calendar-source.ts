import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AdminBotEvidencePointer } from "./contracts.js";

const execFile = promisify(execFileCallback);
const SOURCE_TIMEOUT_MS = 60_000;
const SOURCE_MAX_BYTES = 2 * 1024 * 1024;

export type CalendarSourceParams = {
  summary?: string;
  timeWindow?: string;
  proposedPayload?: unknown;
  sourceUrl?: string;
  calendarUrl?: string;
  calendarName?: "personal" | "jinesis";
  emailMessageId?: string;
  emailQuery?: string;
  evidence?: AdminBotEvidencePointer[];
};

export type ResolvedCalendarSource = {
  summary: string;
  timeWindow?: string;
  proposedPayload?: unknown;
  evidence?: AdminBotEvidencePointer[];
};

type ExtractedCalendarDetails = {
  summary: string;
  timeWindow: string;
  payload: Record<string, unknown>;
  snippet: string;
};

export const ADMINBOT_CALENDARS = {
  personal:
    "a716d3228cbb947fbf5716598420b8a2ee5e05df9d2505cadcc6455881a985f9@group.calendar.google.com",
  jinesis: "jinesis.adminbot@gmail.com",
} as const;

export async function resolveCalendarSource(
  params: CalendarSourceParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCalendarSource> {
  const explicitCalendarUrl = params.calendarUrl?.trim();
  const sourceUrl = params.sourceUrl?.trim();
  const calendarId =
    (explicitCalendarUrl ? calendarIdFromUrl(explicitCalendarUrl) : undefined) ??
    (sourceUrl ? calendarIdFromUrl(sourceUrl) : undefined) ??
    (params.calendarName ? ADMINBOT_CALENDARS[params.calendarName] : undefined);
  if (explicitCalendarUrl && !calendarId) {
    throw new Error(
      "calendarUrl must be a Google Calendar URL containing a src or cid calendar id.",
    );
  }
  const suppliedPayload =
    params.proposedPayload &&
    typeof params.proposedPayload === "object" &&
    !Array.isArray(params.proposedPayload)
      ? (params.proposedPayload as Record<string, unknown>)
      : {};
  const targetPayload = {
    ...(calendarId ? { calendar_id: calendarId } : {}),
    ...suppliedPayload,
  };
  const source = await readCalendarSource(
    calendarId && sourceUrl && calendarIdFromUrl(sourceUrl)
      ? { ...params, sourceUrl: undefined }
      : params,
    env,
  );
  if (!source) {
    if (!params.summary?.trim()) {
      throw new Error(
        "Calendar summary is required when no Google Doc URL, Gmail message id, or Gmail query is provided.",
      );
    }
    return {
      summary: params.summary.trim(),
      ...(params.timeWindow?.trim() ? { timeWindow: params.timeWindow.trim() } : {}),
      ...(Object.keys(targetPayload).length > 0 ? { proposedPayload: targetPayload } : {}),
      ...(params.evidence ? { evidence: params.evidence } : {}),
    };
  }

  const enrichedText = await addLinkedTravelDetails(source.text);
  const extracted = extractCalendarDetails(enrichedText);
  return {
    summary: params.summary?.trim() || extracted.summary,
    timeWindow: params.timeWindow?.trim() || extracted.timeWindow,
    proposedPayload: {
      ...extracted.payload,
      ...targetPayload,
    },
    evidence: [
      ...(params.evidence ?? []),
      {
        source: source.kind,
        ...(source.id ? { id: source.id } : {}),
        ...(source.url ? { url: source.url } : {}),
        snippet: extracted.snippet,
      },
    ],
  };
}

async function readCalendarSource(
  params: CalendarSourceParams,
  env: NodeJS.ProcessEnv,
): Promise<{ kind: string; id?: string; url?: string; text: string } | undefined> {
  const sourceUrl = params.sourceUrl?.trim();
  const docId = sourceUrl ? googleDocId(sourceUrl) : undefined;
  if (docId) {
    return {
      kind: "google_doc",
      id: docId,
      url: sourceUrl,
      text: await exportGoogleDoc(docId, env),
    };
  }

  const messageId = params.emailMessageId?.trim() || (sourceUrl ? gmailId(sourceUrl) : undefined);
  if (messageId) {
    return {
      kind: "gmail_message",
      id: messageId,
      ...(sourceUrl ? { url: sourceUrl } : {}),
      text: await readGmailMessage(messageId, env),
    };
  }

  if (params.emailQuery?.trim()) {
    const query = params.emailQuery.trim();
    const threadId = await findGmailThread(query, env);
    return {
      kind: "gmail_query",
      id: threadId,
      text: await readGmailThread(threadId, env),
    };
  }

  if (sourceUrl) {
    throw new Error(
      "Calendar sourceUrl must be a Google Docs URL or Gmail message URL. Use emailMessageId or emailQuery for other Gmail sources.",
    );
  }
  return undefined;
}

async function exportGoogleDoc(docId: string, env: NodeJS.ProcessEnv): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "adminbot-calendar-"));
  const output = join(directory, "source.txt");
  try {
    await runGog(
      [
        "--no-input",
        "--readonly",
        "--enable-commands-exact",
        "docs.export",
        ...accountArgs(env),
        "docs",
        "export",
        docId,
        "--format",
        "txt",
        "--out",
        output,
        "--overwrite",
      ],
      env,
    );
    return (await readFile(output, "utf8")).slice(0, SOURCE_MAX_BYTES);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readGmailMessage(messageId: string, env: NodeJS.ProcessEnv): Promise<string> {
  return await runGog(
    [
      "--json",
      "--no-input",
      "--readonly",
      "--wrap-untrusted",
      "--enable-commands-exact",
      "gmail.get",
      ...accountArgs(env),
      "gmail",
      "get",
      messageId,
      "--format",
      "full",
      "--sanitize-content",
    ],
    env,
  );
}

async function findGmailThread(query: string, env: NodeJS.ProcessEnv): Promise<string> {
  const output = await runGog(
    [
      "--json",
      "--no-input",
      "--readonly",
      "--wrap-untrusted",
      "--enable-commands-exact",
      "gmail.search",
      ...accountArgs(env),
      "gmail",
      "search",
      query,
      "--max",
      "1",
      "--fail-empty",
    ],
    env,
  );
  const parsed = JSON.parse(output) as unknown;
  const id = findStringField(parsed, ["threadId", "thread_id", "id"]);
  if (!id) {
    throw new Error(`No Gmail thread id was returned for query: ${query}`);
  }
  return id;
}

async function readGmailThread(threadId: string, env: NodeJS.ProcessEnv): Promise<string> {
  return await runGog(
    [
      "--json",
      "--no-input",
      "--readonly",
      "--wrap-untrusted",
      "--enable-commands-exact",
      "gmail.thread.get",
      ...accountArgs(env),
      "gmail",
      "thread",
      "get",
      threadId,
      "--full",
      "--sanitize-content",
    ],
    env,
  );
}

async function addLinkedTravelDetails(text: string): Promise<string> {
  const links = [
    ...text.matchAll(/https:\/\/www\.google\.com\/travel\/flights\/s\/[A-Za-z0-9_-]+/gu),
  ].map((match) => match[0]);
  const additions: string[] = [];
  for (const link of [...new Set(links)].slice(0, 3)) {
    try {
      const response = await fetch(link, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
        headers: { "user-agent": "Mozilla/5.0 AdminBot/1.0" },
      });
      if (!response.ok) continue;
      const html = (await response.text()).slice(0, SOURCE_MAX_BYTES);
      additions.push(decodeGoogleFlightsPayloads(html));
    } catch {
      // The source document remains usable even if an optional public link fails.
    }
  }
  return [text, ...additions].filter(Boolean).join("\n");
}

function decodeGoogleFlightsPayloads(html: string): string {
  const values = [...html.matchAll(/tfs(?:=|\\u003d)([A-Za-z0-9_-]{20,})/gu)].map(
    (match) => match[1],
  );
  const printable: string[] = [];
  for (const value of [...new Set(values)].slice(0, 5)) {
    try {
      const decoded = Buffer.from(value.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
      printable.push(...(decoded.toString("latin1").match(/[ -~]{2,}/gu) ?? []));
    } catch {
      // Ignore malformed public-link payloads.
    }
  }
  return printable.join(" ");
}

export function extractCalendarDetails(text: string): ExtractedCalendarDetails {
  const normalized = text.replace(/^\uFEFF/u, "").replace(/\r/gu, "");
  const dates = extractDates(normalized);
  if (dates.length === 0) {
    throw new Error(
      "No calendar date could be extracted from the Google or Gmail source. Add an explicit date to the source or pass timeWindow.",
    );
  }
  const from = dates[0];
  const lastDate = dates.findLast((date) => daysBetween(from, date) <= 31) ?? from;
  const summary = extractSummary(normalized);
  const timedRange = extractTimeRange(normalized, from, lastDate);
  if (timedRange) {
    return {
      summary,
      timeWindow: `${timedRange.from} through ${timedRange.to}`,
      payload: {
        summary,
        from: timedRange.from,
        to: timedRange.to,
        all_day: false,
        timezone: timedRange.timezone,
        description: "Created from an AdminBot-approved Google or Gmail source.",
      },
      snippet: normalized.replace(/\s+/gu, " ").trim().slice(0, 240),
    };
  }
  const to = nextDate(lastDate);
  return {
    summary,
    timeWindow: from === lastDate ? from : `${from} through ${lastDate}`,
    payload: {
      summary,
      from,
      to,
      all_day: true,
      description: "Created from an AdminBot-approved Google or Gmail source.",
    },
    snippet: normalized.replace(/\s+/gu, " ").trim().slice(0, 240),
  };
}

function extractTimeRange(
  text: string,
  fromDate: string,
  toDate: string,
): { from: string; to: string; timezone: string } | undefined {
  const match =
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|\bto\b|\bthrough\b)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/iu.exec(
      text,
    ) ??
    /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|\bto\b|\bthrough\b)\s*(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/iu.exec(
      text,
    );
  if (!match) return undefined;

  const endMeridiem = normalizeMeridiem(match[6]);
  const startMeridiem = normalizeMeridiem(match[3]) ?? endMeridiem;
  const startHour = clockHour(Number(match[1]), startMeridiem);
  const endHour = clockHour(Number(match[4]), endMeridiem);
  const startMinute = Number(match[2] ?? 0);
  const endMinute = Number(match[5] ?? 0);
  if (startHour === undefined || endHour === undefined || startMinute > 59 || endMinute > 59) {
    return undefined;
  }

  const timezone = extractTimezone(text);
  const start = localRfc3339(fromDate, startHour, startMinute, timezone);
  let endDate = toDate;
  if (
    fromDate === toDate &&
    (endHour < startHour || (endHour === startHour && endMinute <= startMinute))
  ) {
    endDate = nextDate(toDate);
  }
  return {
    from: start,
    to: localRfc3339(endDate, endHour, endMinute, timezone),
    timezone,
  };
}

function normalizeMeridiem(value: string | undefined): "am" | "pm" | undefined {
  if (!value) return undefined;
  return value.toLowerCase().startsWith("a") ? "am" : "pm";
}

function clockHour(hour: number, meridiem: "am" | "pm" | undefined): number | undefined {
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    return meridiem === "am" ? hour % 12 : (hour % 12) + 12;
  }
  return hour >= 0 && hour <= 23 ? hour : undefined;
}

function extractTimezone(text: string): string {
  if (/\b(?:UTC|GMT)\b/iu.test(text)) return "UTC";
  if (/\bEST\b/u.test(text)) return "Etc/GMT+5";
  if (/\bEDT\b/u.test(text)) return "Etc/GMT+4";
  return "America/Toronto";
}

function localRfc3339(date: string, hour: number, minute: number, timezone: string): string {
  const offset = timezoneOffset(date, timezone);
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}`;
}

function timezoneOffset(date: string, timezone: string): string {
  if (timezone === "UTC") return "+00:00";
  if (timezone === "Etc/GMT+5") return "-05:00";
  if (timezone === "Etc/GMT+4") return "-04:00";
  const instant = new Date(`${date}T12:00:00.000Z`);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-]\d{2}:\d{2})/u.exec(name ?? "");
  return match?.[1] ?? "-05:00";
}

function extractSummary(text: string): string {
  const subject =
    /"(?:subject|title|summary)"\s*:\s*"([^"]{2,160})"/iu.exec(text)?.[1] ??
    /^(?:subject|title|summary|event)\s*:\s*(.{2,160})$/imu.exec(text)?.[1];
  if (subject?.trim()) return subject.trim();

  const flightCodes = [...text.matchAll(/\b[A-Z]{3}\b/gu)]
    .map((match) => match[0])
    .filter((code) => !["UTC", "GMT"].includes(code));
  const uniqueCodes = [...new Set(flightCodes)];
  if (uniqueCodes.length >= 2) {
    return `Flight ${uniqueCodes[0]} \u2194 ${uniqueCodes[1]}`;
  }

  const firstLine = text
    .split("\n")
    .map((line) => line.replace(/^[-*#\s]+/u, "").trim())
    .find(
      (line) =>
        line.length >= 3 &&
        line.length <= 160 &&
        !/^https?:\/\//iu.test(line) &&
        !/^(flight|date|time|when|meta information)\s*:?\s*$/iu.test(line),
    );
  return firstLine || "Calendar entry from Google source";
}

function extractDates(text: string): string[] {
  const candidates: Array<{ date: string; index: number }> = [];
  const ignored = /(birth|birthday|passport|expiration|expires|member|frequent traveler)/iu;
  const add = (year: number, month: number, day: number, index: number) => {
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const nextNewline = text.indexOf("\n", index);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const context = text.slice(lineStart, lineEnd);
    if (ignored.test(context)) return;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    ) {
      candidates.push({ date: parsed.toISOString().slice(0, 10), index });
    }
  };

  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) {
    add(Number(match[1]), Number(match[2]), Number(match[3]), match.index);
  }
  for (const match of text.matchAll(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))\b/giu,
  )) {
    add(Number(match[3]), monthNumber(match[1]), Number(match[2]), match.index);
  }
  for (const match of text.matchAll(
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/giu,
  )) {
    add(Number(match[3]), monthNumber(match[2]), Number(match[1]), match.index);
  }
  for (const match of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/gu)) {
    add(Number(match[3]), Number(match[1]), Number(match[2]), match.index);
  }

  const today = new Date();
  const floor = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1),
  )
    .toISOString()
    .slice(0, 10);
  return [
    ...new Set(
      candidates
        .filter((candidate) => candidate.date >= floor)
        .sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index)
        .map((candidate) => candidate.date),
    ),
  ];
}

function monthNumber(value: string): number {
  return (
    [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ].indexOf(value.toLowerCase()) + 1
  );
}

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

export function calendarIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "calendar.google.com" && !url.hostname.endsWith(".calendar.google.com")) {
      return undefined;
    }
    const calendarId = url.searchParams.get("src") ?? url.searchParams.get("cid");
    return calendarId?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function googleDocId(url: string): string | undefined {
  return /docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/u.exec(url)?.[1];
}

function gmailId(url: string): string | undefined {
  if (!/(?:mail|gmail)\.google\.com/u.test(url)) return undefined;
  return /(?:#|\/)(?:inbox\/|all\/|search\/[^/]+\/)?([A-Za-z0-9_-]{12,})$/u.exec(url)?.[1];
}

function accountArgs(env: NodeJS.ProcessEnv): string[] {
  const account = env.GOG_ACCOUNT?.trim();
  return account ? ["--account", account] : [];
}

async function runGog(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await execFile("gog", args, {
      env,
      maxBuffer: SOURCE_MAX_BYTES,
      timeout: SOURCE_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    const detail =
      typeof failure.stderr === "string"
        ? failure.stderr
            .replace(/[\u0000-\u001f\u007f]+/gu, " ")
            .trim()
            .slice(0, 500)
        : "";
    throw new Error(
      detail
        ? `Unable to read calendar source with gog: ${detail}`
        : "Unable to read calendar source with gog",
    );
  }
}

function findStringField(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringField(entry, keys);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  for (const entry of Object.values(record)) {
    const found = findStringField(entry, keys);
    if (found) return found;
  }
  return undefined;
}
