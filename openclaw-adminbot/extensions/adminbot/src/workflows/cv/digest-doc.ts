// The CV Updates Google Doc, rendered from the change ledger. Pure string building over a clock:
// the write itself lives in the gog connector, so the document body is unit-testable without
// touching Google.
//
// The doc is rendered from the *whole* ledger on every run rather than from the scan that just
// finished. A scan consumes its own diff -- it compares each member's CV against the snapshot the
// last run stored, then overwrites that snapshot -- so a second run over a settled roster reports
// nothing at all. Publishing only the newest scan would therefore blank the document on any quiet
// week. The ledger is the source of truth; the doc is a view of it, and rewriting the view in full
// keeps the job idempotent: running it twice in a row produces the same document.

import type { AdminBotCvChangeEvent, AdminBotCvEntry } from "../../contracts/actions.js";
import { cvEntryKey } from "../../contracts/actions.js";
import { describeCvEntry, isNewsworthy } from "../../cv-scan.js";

export const CV_DIGEST_DOC_TITLE = "CV Updates";

export type AdminBotCvDigestDocument = {
  markdown: string;
  // What the caller reports back to the console, so the button can say what it did without the
  // UI re-deriving it from the markdown.
  day_count: number;
  change_count: number;
};

/**
 * Renders the ledger as the document body: a dated header, then one section per day a change was
 * detected, newest first.
 *
 * Only newsworthy changes reach the page. The ledger deliberately records everything a scan saw
 * appear, including entries whose start date sits well outside the recency window, because an
 * admin may still want to write those up by hand -- but a backfilled 2019 position announced as
 * lab news reads as an error, so the document shows what the newsletter would actually carry.
 */
export function renderCvDigestDocument(
  changes: AdminBotCvChangeEvent[],
  now: Date,
): AdminBotCvDigestDocument {
  const newsworthy = changes.filter((change) =>
    isNewsworthy({ entry: change.entry, recency: change.recency }),
  );
  const days = groupByDetectionDay(newsworthy);
  const lines: string[] = [`# ${CV_DIGEST_DOC_TITLE}`, "", `_Updated ${formatDay(now)}_`, ""];
  if (!days.length) {
    lines.push(
      "No CV changes have been recorded yet. Run the CV digest job again after members update their linked CVs.",
    );
    return { markdown: `${lines.join("\n")}\n`, day_count: 0, change_count: 0 };
  }
  for (const day of days) {
    lines.push(`## ${formatDay(new Date(`${day.iso}T00:00:00Z`))}`, "");
    lines.push(...day.lines);
    lines.push("");
  }
  return {
    markdown: `${lines.join("\n").trimEnd()}\n`,
    day_count: days.length,
    change_count: newsworthy.length,
  };
}

type DigestDay = { iso: string; lines: string[] };

function groupByDetectionDay(changes: AdminBotCvChangeEvent[]): DigestDay[] {
  const byDay = new Map<string, AdminBotCvChangeEvent[]>();
  for (const change of changes) {
    const iso = change.detected_at.slice(0, 10);
    // A malformed detected_at would otherwise open a section headed "Invalid Date". The ledger
    // writes ISO timestamps, so this only fires on hand-edited rows, but it drops the change into
    // an undated bucket rather than corrupting the whole document.
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) {
      continue;
    }
    const bucket = byDay.get(iso);
    if (bucket) {
      bucket.push(change);
      continue;
    }
    byDay.set(iso, [change]);
  }
  return [...byDay.entries()]
    .toSorted((a, b) => b[0].localeCompare(a[0]))
    .map(([iso, rows]) => ({ iso, lines: renderDayLines(rows) }));
}

/**
 * One day's changes as bullet lines.
 *
 * Publications are collapsed across co-authors: a paper appears on every author's CV, so a lab
 * where five people co-wrote something would otherwise announce it five times. Everything else is
 * per-member, because two people starting the same job is genuinely two events.
 */
function renderDayLines(changes: AdminBotCvChangeEvent[]): string[] {
  const lines: string[] = [];
  const publications = new Map<string, { names: string[]; entry: AdminBotCvEntry }>();
  for (const change of changes) {
    if (change.entry.kind !== "publication") {
      lines.push(`- **${change.member_name}** — ${describeCvEntry(change.entry)}`);
      continue;
    }
    const key = cvEntryKey(change.entry);
    const existing = publications.get(key);
    if (!existing) {
      publications.set(key, { names: [change.member_name], entry: change.entry });
      continue;
    }
    if (!existing.names.includes(change.member_name)) {
      existing.names.push(change.member_name);
    }
  }
  for (const { names, entry } of publications.values()) {
    lines.push(`- **${formatNameList(names)}** — ${describeCvEntry(entry)}`);
  }
  return lines;
}

function formatNameList(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Written out longhand ("20 August 2026") rather than as an ISO date: the header is read by
// whoever opens the doc, not parsed by anything.
function formatDay(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
