// Typed CSV inputs for the workshop recommendation workflow.
//
// The CSV seam is deliberately small and strict: F must run before the production paper adapters
// are accepted, but accepting a misspelled header as an empty field would produce plausible-looking
// recommendations for the wrong person. Values may be blank where the contract permits it; the
// columns themselves may not silently disappear.

import type { WorkshopAttendance, WorkshopNudgePaper } from "./workshop-nudges.js";

const PAPER_HEADERS = [
  "paper_id",
  "title",
  "year",
  "current_submission_state",
  "topic_summary",
  "lab_author_names",
  "recipient_member_id",
  "recipient_display_name",
  "publication_source",
] as const;

const ATTENDANCE_HEADERS = [
  "member_id",
  "parent_conference_key",
  "attendance_likelihood",
  "source",
  "last_confirmed_at",
] as const;

export function parseWorkshopNudgePapers(csv: string): WorkshopNudgePaper[] {
  const rows = records(csv, PAPER_HEADERS);
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const paperId = required(row.paper_id, "paper_id", index);
    const title = required(row.title, "title", index);
    if (seen.has(paperId)) {
      throw new Error(`paper CSV row ${index + 2}: duplicate paper_id ${paperId}`);
    }
    seen.add(paperId);
    const year = row.year.trim();
    if (year && !/^\d{4}$/u.test(year)) {
      throw new Error(`paper CSV row ${index + 2}: year must be four digits or blank`);
    }
    return {
      paper_id: paperId,
      title,
      ...(year ? { year: Number(year) } : {}),
      ...(row.current_submission_state.trim()
        ? { current_submission_state: row.current_submission_state.trim() }
        : {}),
      ...(row.topic_summary.trim() ? { topic_summary: row.topic_summary.trim() } : {}),
      lab_author_names: splitList(row.lab_author_names),
      ...(row.recipient_member_id.trim()
        ? { recipient_member_id: row.recipient_member_id.trim() }
        : {}),
      ...(row.recipient_display_name.trim()
        ? { recipient_display_name: row.recipient_display_name.trim() }
        : {}),
      publication_sources: splitList(row.publication_source),
    };
  });
}

export function parseWorkshopAttendance(csv: string | undefined): WorkshopAttendance[] {
  if (!csv?.trim()) {
    return [];
  }
  const rows = records(csv, ATTENDANCE_HEADERS);
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const memberId = required(row.member_id, "member_id", index);
    const parentKey = required(row.parent_conference_key, "parent_conference_key", index);
    const key = `${memberId}\u0000${parentKey}`;
    if (seen.has(key)) {
      throw new Error(
        `attendance CSV row ${index + 2}: duplicate member/event pair ${memberId}/${parentKey}`,
      );
    }
    seen.add(key);
    const rawLikelihood = row.attendance_likelihood.trim();
    const likelihood = rawLikelihood ? Number(rawLikelihood) : undefined;
    if (
      likelihood !== undefined &&
      (!Number.isInteger(likelihood) || likelihood < 0 || likelihood > 100)
    ) {
      throw new Error(
        `attendance CSV row ${index + 2}: attendance_likelihood must be an integer from 0 to 100 or blank`,
      );
    }
    const lastConfirmedAt = required(row.last_confirmed_at, "last_confirmed_at", index);
    if (!Number.isFinite(Date.parse(lastConfirmedAt))) {
      throw new Error(
        `attendance CSV row ${index + 2}: last_confirmed_at must be an ISO date or instant`,
      );
    }
    return {
      member_id: memberId,
      parent_conference_key: parentKey,
      ...(likelihood === undefined ? {} : { attendance_likelihood: likelihood }),
      source: required(row.source, "source", index),
      last_confirmed_at: lastConfirmedAt,
    };
  });
}

function records<const Headers extends readonly string[]>(
  csv: string,
  requiredHeaders: Headers,
): Array<Record<Headers[number], string>> {
  const rows = parseCsv(csv).filter((row) => row.some((cell) => cell.trim()));
  const header = rows.shift()?.map((cell) => cell.trim().replace(/^\ufeff/u, "")) ?? [];
  if (!header.length) {
    throw new Error("CSV is empty");
  }
  const positions = new Map(header.map((name, index) => [name, index]));
  const missing = requiredHeaders.filter((name) => !positions.has(name));
  if (missing.length) {
    throw new Error(
      `CSV is missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
  return rows.map(
    (cells) =>
      Object.fromEntries(
        requiredHeaders.map((name) => [name, cells[positions.get(name) as number] ?? ""]),
      ) as Record<Headers[number], string>,
  );
}

/** RFC 4180 fields, including quoted newlines and doubled quote escapes. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index] as string;
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && !field) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new Error("CSV ends inside a quoted field");
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

function required(value: string, name: string, rowIndex: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`CSV row ${rowIndex + 2}: ${name} is required`);
  }
  return trimmed;
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split("|")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}
