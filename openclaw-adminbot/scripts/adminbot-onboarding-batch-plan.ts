#!/usr/bin/env tsx
// Builds the onboarding batch plan from the lab's contact sheet: who gets mailed, with which
// template, and what each send still needs.
//
//   node --import tsx scripts/adminbot-onboarding-batch-plan.ts --rows rows.json [--out plan.json]
//
// `rows.json` is the "Full Slack Member List" tab as a row matrix (row 1 = headers), which is what
// `readGogSheetRows` returns and what an xlsx export converts to.
//
// Two groups, per the batch review:
//
//   1. The direct-matching applicants -- a contiguous block of rows at the end of the sheet, given
//      by --matching-rows (default 169-182, spreadsheet numbering). These get the project-matching
//      mail. They have no name and no Member Type: the row is an applicant, not a member, and the
//      address sits in the "Slack email" column with the intended task in "Member Attributes".
//   2. Everyone whose "Test Onboard" is 3, who gets the onboarding template their Member Type maps
//      to. Member Type is multi-valued ("alumni, coauthor-major"), so it is resolved through the
//      same `classify()` the roster import uses rather than by a second, divergent rule here.
//
// Nothing is sent and nothing is written back to the sheet. This emits a plan for review; mailing
// it is a separate, approved step. That split is the point: the previous batch's damage came from
// generating and sending in one motion, so anything this cannot fill becomes a `needs` entry a
// human answers rather than a blank that ships.
import fs from "node:fs";
import { findOnboardingTemplate } from "../extensions/adminbot/src/workflows/onboarding/emails.ts";
import { renderTaskRecommendation } from "../extensions/adminbot/src/workflows/onboarding/task-recommendations.ts";
import { classify } from "./adminbot-import-member-types.ts";

const NAME_COL = 0;
const CORRESPONDENCE_COL = 4;
const CALENDAR_COL = 6;
const SLACK_EMAIL_COL = 16;
const TEST_ONBOARD_COL = 17;
const MEMBER_TYPE_COL = 18;
const MEMBER_ATTRIBUTES_COL = 19;
const PROJECTS_COL = 20;
const THEME_COL = 21;
const TLDR_COL = 22;

/** The batch the review named: "Test Onboard = 3". Excel hands these back as "3.0". */
const TEST_ONBOARD_GROUP = "3";

/**
 * The reviewed applicant -> recommendation mapping, read from `--matches <file>`.
 *
 * Deliberately not a constant in this file. It is keyed by individuals' personal addresses, which
 * belong in the sheet and the batch artifact rather than in the tracked tree, and it is decision
 * data that changes every batch while this code does not. The file is a flat object:
 *
 *   { "someone@example.edu": "adminbot_only", ... }
 *
 * An applicant absent from it is not guessed at from their "Member Attributes" free text: the
 * sentence claims to be Zhijing's personal judgement about a named person, so an unreviewed row
 * surfaces as a `needs` instead.
 */
export type RecommendationMatches = Readonly<Record<string, string>>;

type Row = readonly string[];

function cell(row: Row, index: number): string {
  return (row[index] ?? "").trim();
}

/** "3.0" and "3" are the same batch; Excel decides which one you get. */
function testOnboardGroup(row: Row): string {
  const raw = cell(row, TEST_ONBOARD_COL);
  return raw.endsWith(".0") ? raw.slice(0, -2) : raw;
}

/**
 * The addresses on a row, best first.
 *
 * Applicant rows carry their contact address in the "Slack email" column, so that column is a
 * candidate rather than a Slack-only field. One row holds two addresses on separate lines; both
 * are surfaced so a human picks, instead of the parser silently taking the first.
 */
function addressesOf(row: Row): string[] {
  const raw = [
    cell(row, CORRESPONDENCE_COL),
    cell(row, SLACK_EMAIL_COL),
    cell(row, CALENDAR_COL),
  ].join("\n");
  const seen = new Set<string>();
  const found: string[] = [];
  for (const candidate of raw.split(/[\s,;]+/u)) {
    const value = candidate.trim();
    if (value.includes("@") && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      found.push(value);
    }
  }
  return found;
}

export type PlanEntry = {
  sheet_row: number;
  name: string;
  email: string;
  other_addresses?: string[];
  template_id: string;
  member_type?: string;
  also_named?: string[];
  values: Record<string, string>;
  /** Everything a human still has to supply before this can be sent. */
  needs: string[];
  note?: string;
};

export type Plan = {
  generated_at: string;
  direct_matching: PlanEntry[];
  test_onboard_3: PlanEntry[];
  skipped: { sheet_row: number; name: string; reason: string }[];
};

/** Tokens the send path generates or resolves itself, so they are never a `needs`. */
const PROVIDED_AT_SEND = new Set([
  "drive_folder_link",
  "slack_connect_link",
  "first_name",
  "member_email",
  "zhijing_whatsapp",
]);

function needsFor(templateId: string, values: Record<string, string>): string[] {
  const template = findOnboardingTemplate(templateId);
  if (!template) {
    return [`unknown template: ${templateId}`];
  }
  return template.required
    .filter((token) => !PROVIDED_AT_SEND.has(token) && !values[token]?.trim())
    .toSorted();
}

/**
 * Addresses for people the sheet has no address for, passed as `--email "Full Name=addr@example"`.
 *
 * A flag rather than a constant in this file: these are individuals' personal addresses, and the
 * sheet is the place they belong. Korinna Fragkia is the standing case -- typed `coauthor-minor`
 * and in the batch, but her row carries no correspondence, Slack or calendar address, so she was
 * silently absent from the previous run.
 */
export function parseEmailOverrides(argv: readonly string[]): Map<string, string> {
  const overrides = new Map<string, string>();
  argv.forEach((arg, index) => {
    if (arg !== "--email") {
      return;
    }
    const pair = argv[index + 1] ?? "";
    const split = pair.indexOf("=");
    if (split > 0) {
      overrides.set(pair.slice(0, split).trim().toLowerCase(), pair.slice(split + 1).trim());
    }
  });
  return overrides;
}

export function buildPlan(
  rows: readonly Row[],
  matchingRange: readonly [number, number],
  matches: RecommendationMatches = {},
  emailOverrides: ReadonlyMap<string, string> = new Map(),
): Plan {
  const plan: Plan = {
    generated_at: new Date().toISOString(),
    direct_matching: [],
    test_onboard_3: [],
    skipped: [],
  };
  const [firstRow, lastRow] = matchingRange;

  for (let sheetRow = firstRow; sheetRow <= lastRow; sheetRow += 1) {
    const row = rows[sheetRow - 1];
    if (!row) {
      continue;
    }
    const addresses = addressesOf(row);
    const attributes = cell(row, MEMBER_ATTRIBUTES_COL);
    if (addresses.length === 0) {
      // Rows carrying only a note ("can Joeun review all EngSci applicants?") are not people.
      plan.skipped.push({
        sheet_row: sheetRow,
        name: cell(row, NAME_COL),
        reason: attributes
          ? `no email address on this row (it carries only a note: "${attributes.split("\n")[0]}")`
          : "empty row",
      });
      continue;
    }
    const [email, ...others] = addresses;
    const recommendationId = matches[(email ?? "").toLowerCase()];
    const values: Record<string, string> = {};
    const needs: string[] = [];

    if (!recommendationId) {
      needs.push(
        `task_recommendation: no approved sentence covers this match yet ("${attributes.split("\n")[0]}")`,
      );
    } else {
      const rendered = renderTaskRecommendation(recommendationId, {});
      if (rendered.ok) {
        values.task_recommendation = rendered.text;
      } else {
        needs.push(
          rendered.reason === "unknown-id"
            ? `task_recommendation: unknown id ${recommendationId}`
            : `task_recommendation (${recommendationId}) needs ${rendered.missing.join(", ")}`,
        );
      }
    }
    // Always a human step: it is one person's own response link and there is no API that returns it.
    needs.push('application_form_link: this applicant\'s own "edit response" URL');

    plan.direct_matching.push({
      sheet_row: sheetRow,
      name: cell(row, NAME_COL),
      email: email ?? "",
      ...(others.length ? { other_addresses: others } : {}),
      template_id: "interview_invite_project_matching",
      ...(recommendationId
        ? { values: { ...values, recommendation: recommendationId } }
        : { values }),
      needs,
      ...(attributes ? { note: attributes } : {}),
    });
  }

  for (let sheetRow = 2; sheetRow <= rows.length; sheetRow += 1) {
    const row = rows[sheetRow - 1];
    if (!row || testOnboardGroup(row) !== TEST_ONBOARD_GROUP) {
      continue;
    }
    const name = cell(row, NAME_COL);
    const memberType = cell(row, MEMBER_TYPE_COL);
    const classified = classify(memberType);
    if (classified.kind !== "collaborator") {
      plan.skipped.push({
        sheet_row: sheetRow,
        name,
        reason: `Member Type "${memberType}" does not map to a subgroup`,
      });
      continue;
    }
    const templateId = classified.collaborator_subgroup;
    if (!findOnboardingTemplate(templateId)) {
      plan.skipped.push({
        sheet_row: sheetRow,
        name,
        reason: `no onboarding template exists for ${templateId} (from Member Type "${memberType}")`,
      });
      continue;
    }
    const override = emailOverrides.get(name.toLowerCase());
    const addresses = override ? [override, ...addressesOf(row)] : addressesOf(row);
    const values: Record<string, string> = {};
    const projects = cell(row, PROJECTS_COL) || cell(row, THEME_COL);
    if (projects) {
      values.project_or_context = projects.split("\n")[0] ?? "";
    }
    if (cell(row, TLDR_COL)) {
      values.record_role = cell(row, TLDR_COL);
    }
    const needs = needsFor(templateId, values);
    if (addresses.length === 0) {
      needs.unshift("email: no address on this sheet row");
    }
    const [email, ...others] = addresses;
    plan.test_onboard_3.push({
      sheet_row: sheetRow,
      name,
      email: email ?? "",
      ...(others.length ? { other_addresses: others } : {}),
      template_id: templateId,
      member_type: memberType,
      ...(classified.alsoNamed.length ? { also_named: classified.alsoNamed } : {}),
      values,
      needs,
    });
  }
  return plan;
}

function main(argv: readonly string[]): void {
  const rowsIndex = argv.indexOf("--rows");
  if (rowsIndex === -1 || !argv[rowsIndex + 1]) {
    console.error(
      'usage: --rows <rows.json> [--matches <matches.json>] [--out <plan.json>] [--matching-rows <first>-<last>] [--email "Name=addr@example"]...',
    );
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(argv[rowsIndex + 1] as string, "utf8")) as Row[];
  const rangeIndex = argv.indexOf("--matching-rows");
  const rangeRaw = rangeIndex === -1 ? "169-182" : (argv[rangeIndex + 1] ?? "169-182");
  const [first, last] = rangeRaw.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(first) || !Number.isInteger(last)) {
    console.error(`--matching-rows must look like 169-182, got ${rangeRaw}`);
    process.exit(1);
  }
  const matchesIndex = argv.indexOf("--matches");
  const matches: RecommendationMatches =
    matchesIndex === -1 || !argv[matchesIndex + 1]
      ? {}
      : (JSON.parse(
          fs.readFileSync(argv[matchesIndex + 1] as string, "utf8"),
        ) as RecommendationMatches);
  const plan = buildPlan(
    rows,
    [first as number, last as number],
    matches,
    parseEmailOverrides(argv),
  );
  const output = `${JSON.stringify(plan, undefined, 2)}\n`;
  const outIndex = argv.indexOf("--out");
  if (outIndex !== -1 && argv[outIndex + 1]) {
    fs.writeFileSync(argv[outIndex + 1] as string, output);
  } else {
    console.log(output);
  }
  console.error(
    `direct matching: ${plan.direct_matching.length}, test onboard 3: ${plan.test_onboard_3.length}, skipped: ${plan.skipped.length}`,
  );
  for (const entry of plan.skipped) {
    console.error(`  skipped row ${entry.sheet_row} ${entry.name}: ${entry.reason}`);
  }
}

if (process.argv[1]?.endsWith("adminbot-onboarding-batch-plan.ts")) {
  main(process.argv.slice(2));
}
