// Turning a forwarded Zoom "cloud recording is available" notice into something the meetings
// workflow can file.
//
// The lab's Zoom is an educational account with developer mode off: no Marketplace app, no OAuth,
// no API. The one thing Zoom hands over without any of that is the mail it sends the host when a
// cloud recording finishes, so that mail is the whole integration -- a filter on the hosting
// account forwards it to the bot mailbox and the hourly email pass reads it there.
//
// Everything here is pure and deliberately tolerant, for two reasons. Gmail rewrites a forwarded
// message: the envelope is no longer no-reply@zoom.us, the body arrives quoted with "> " prefixes,
// and it may arrive as HTML. So nothing may key on the sender. And Zoom's template is not a
// contract -- the wording has moved between releases and differs by locale -- so a label that
// fails to match degrades to "absent" rather than throwing. The share URL is the one exception: a
// notice naming no recording is not a notice.
import { createHash } from "node:crypto";
import { toAbsoluteRfc3339 } from "../calendar/time.js";

/**
 * Where a Zoom wall-clock time is assumed to be when the notice does not name a zone we know.
 *
 * Zoom stamps the date in the *host's* profile timezone and labels it in prose ("Eastern Time (US
 * and Canada)"), which is not an IANA name. Recognized labels win; this is what an unrecognized
 * one falls back to, and the lab is in Toronto.
 */
export const DEFAULT_MEETING_ZONE = "America/Toronto";

// Only the labels a Toronto lab actually receives. An unlisted label is not an error -- it falls
// back to DEFAULT_MEETING_ZONE, which is right far more often than it is wrong here.
const ZONE_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/eastern time/iu, "America/Toronto"],
  [/central time/iu, "America/Chicago"],
  [/mountain time/iu, "America/Denver"],
  [/pacific time/iu, "America/Los_Angeles"],
  [/\bUTC\b|\bGMT\b/u, "UTC"],
];

// A recording link, in either of the two forms Zoom mails: /rec/share/<token> for the viewer link
// and /rec/play/<token> for the host's own. Stops at whitespace and at the characters that would
// otherwise swallow a closing bracket or quote from the surrounding markup.
const SHARE_URL = /https?:\/\/[a-z0-9.-]*zoom\.us\/rec\/(?:share|play)\/[^\s<>"')\]]+/iu;

const MONTHS = [
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
];

const NAMED_DATE =
  /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])\.?[Mm]\.?/u;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})/u;
const MEETING_ID = /meeting\s*id\s*:?\s*([\d\s-]{9,20})/iu;

export type ZoomRecordingNotice = {
  topic: string;
  /** RFC3339, when the date line parsed. Absent is survivable: the ingest falls back to the mail's own timestamp. */
  startedAt?: string;
  /** The date line exactly as Zoom wrote it, kept whether or not it parsed, so a failure is diagnosable from the record. */
  startedAtText?: string;
  shareUrl: string;
  passcode?: string;
  meetingId?: string;
};

/**
 * Cheap deterministic gate, run before the classifier model sees the message.
 *
 * Recording notices must never reach the LLM classifier: it has no category for them, so it would
 * file one as `unknown` and park a perfectly machine-readable mail in the needs-review pile. A
 * zoom.us recording URL in the body is a strong enough signal on its own -- no human writes one by
 * accident -- and it survives every forwarding rewrite, which the subject line does not.
 */
export function looksLikeZoomRecordingNotice(subject: string, body: string): boolean {
  return SHARE_URL.test(normalizeNoticeBody(body)) || SHARE_URL.test(subject);
}

/**
 * The body as flat quoted-free plain text.
 *
 * Exported because the ingest logs what it parsed against, and a diagnosis that shows the HTML
 * soup rather than the text the patterns actually ran on is worse than no diagnosis.
 */
export function normalizeNoticeBody(body: string): string {
  const text = looksLikeHtml(body) ? stripHtml(body) : body;
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[\s>]+/u, "").trimEnd())
    .join("\n");
}

function looksLikeHtml(body: string): boolean {
  return /<\/?(?:p|br|div|a|table|span|body)\b/iu.test(body);
}

function stripHtml(body: string): string {
  return decodeEntities(
    body
      // Zoom's HTML puts the share link in an anchor whose text is the URL, but a <br> or a </p>
      // between two fields is the only thing separating "Topic:" from its value once tags go.
      .replace(/<\s*(?:br|\/p|\/div|\/tr|\/h\d)\s*\/?>/giu, "\n")
      .replace(/<[^>]*>/gu, " "),
  );
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/giu, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/**
 * The value of the first label that matches, or undefined.
 *
 * Labels are matched at the start of a line only. Zoom's own body says "Topic: Weekly Meeting" on
 * its own line; the word "topic" inside a sentence elsewhere in the mail is not a field, and
 * matching it mid-line is how a parser starts returning half a sentence as a meeting title.
 */
function labelledValue(body: string, labels: readonly string[]): string | undefined {
  for (const line of body.split("\n")) {
    for (const label of labels) {
      const pattern = new RegExp(`^${label}\\s*:\\s*(.+)$`, "iu");
      const value = pattern.exec(line)?.[1]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

/** The topic Zoom put in the subject: "Cloud Recording - <topic> is now available". */
export function topicFromSubject(subject: string): string | undefined {
  const withoutForwardMarkers = subject.replace(/^\s*(?:(?:fwd?|re|fw)\s*:\s*)+/iu, "").trim();
  const match =
    /^cloud\s+recording\s*[-–—]\s*(.+?)\s+is\s+now\s+available/iu.exec(withoutForwardMarkers) ??
    /^(.+?)\s+is\s+now\s+available/iu.exec(withoutForwardMarkers);
  return match?.[1]?.trim() || undefined;
}

/**
 * The instant a date line names, resolved through the zone the line itself declares.
 *
 * Resolving to an absolute instant rather than keeping wall-clock text is the same argument
 * calendar/time.ts makes: an offset has to be correct for that date, and getting daylight saving
 * wrong moves a weekly meeting by an hour twice a year.
 */
export function parseNoticeDate(text: string, fallbackZone = DEFAULT_MEETING_ZONE): string | undefined {
  const zone = ZONE_LABELS.find(([pattern]) => pattern.test(text))?.[1] ?? fallbackZone;
  const iso = ISO_DATE.exec(text);
  if (iso) {
    const [, year, month, day, hour, minute] = iso;
    return toAbsoluteRfc3339(`${year}-${month}-${day}T${pad(hour)}:${minute}`, zone);
  }
  const named = NAMED_DATE.exec(text);
  if (!named) {
    return undefined;
  }
  const [, monthName, day, year, hour, minute, meridiem] = named;
  const monthIndex = MONTHS.findIndex((month) => month.startsWith((monthName ?? "").toLowerCase()));
  if (monthIndex < 0) {
    return undefined;
  }
  const hour24 = to24Hour(Number(hour), meridiem ?? "");
  return toAbsoluteRfc3339(
    `${year}-${pad(String(monthIndex + 1))}-${pad(day ?? "")}T${pad(String(hour24))}:${minute}`,
    zone,
  );
}

function to24Hour(hour: number, meridiem: string): number {
  const isPm = meridiem.toLowerCase() === "p";
  if (hour === 12) {
    return isPm ? 12 : 0;
  }
  return isPm ? hour + 12 : hour;
}

function pad(value: string): string {
  return value.padStart(2, "0");
}

/**
 * A Zoom notice, or undefined when the mail is not one.
 *
 * `topic` falls back through the body label, the subject, and finally a constant, because a
 * recording with an awkward title is still a recording worth filing; `shareUrl` has no fallback
 * for the reason in the header.
 */
export function parseZoomRecordingNotice(message: {
  subject: string;
  body: string;
}): ZoomRecordingNotice | undefined {
  const body = normalizeNoticeBody(message.body);
  const shareUrl = SHARE_URL.exec(body)?.[0] ?? SHARE_URL.exec(message.subject)?.[0];
  if (!shareUrl) {
    return undefined;
  }
  const startedAtText = labelledValue(body, [
    "date and time",
    "date/time",
    "meeting time",
    "start time",
    "date",
  ]);
  const meetingId = MEETING_ID.exec(body)?.[1]?.replace(/[\s-]/gu, "");
  return {
    topic:
      labelledValue(body, ["topic", "meeting topic"]) ??
      topicFromSubject(message.subject) ??
      "Untitled Zoom meeting",
    ...(startedAtText ? { startedAtText } : {}),
    ...(startedAtText && parseNoticeDate(startedAtText)
      ? { startedAt: parseNoticeDate(startedAtText) }
      : {}),
    shareUrl: shareUrl.replace(/[.,;]$/u, ""),
    ...(readPasscode(body) ? { passcode: readPasscode(body) } : {}),
    ...(meetingId ? { meetingId } : {}),
  };
}

/**
 * The share passcode, rejected unless it looks like one.
 *
 * "Passcode:" is followed by an opaque token with no spaces in it. Anything containing whitespace
 * came from a sentence the label pattern matched by accident ("Passcode: this recording is
 * protected"), and storing that as a passcode would put a wrong string in front of every member
 * who tries to open the link.
 */
function readPasscode(body: string): string | undefined {
  const value = labelledValue(body, [
    "passcode",
    "access passcode",
    "recording passcode",
    "password",
  ]);
  if (!value || /\s/u.test(value) || value.length < 4 || value.length > 32) {
    return undefined;
  }
  return value;
}

/**
 * A stable id for the meeting this notice describes.
 *
 * Keyed on meeting id *and* date because a weekly meeting reuses its Zoom meeting id forever --
 * keying on the id alone would make every week overwrite the last. When the id is missing the
 * share token stands in: it is unique per recording, and hashing keeps an opaque credential-ish
 * string out of a value that ends up in URLs and logs.
 */
export function meetingRecordId(notice: ZoomRecordingNotice): string {
  const day = notice.startedAt?.slice(0, 10);
  if (notice.meetingId && day) {
    return `zoom-${notice.meetingId}-${day}`;
  }
  const token = notice.shareUrl.split("/").pop() ?? notice.shareUrl;
  return `zoom-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}
