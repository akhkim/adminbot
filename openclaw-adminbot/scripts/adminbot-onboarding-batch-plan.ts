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
// Every entry carries its full draft -- subject and body, composed from the same templates the
// send path uses -- so the plan can be read as mail rather than as metadata. Values still
// outstanding appear in the body as a literal `{token}` and are listed in `needs`.
//
// Links stay in the copy's own `[label](url)` notation rather than being flattened to
// "label (url)". The flattened form is what a text-only client receives, but it is lossy: nothing
// in it says which half was the anchor, so a person pasting the draft into Gmail cannot rebuild
// the hyperlink. The bracket form survives that round trip -- paste it anywhere that understands
// markdown, or hand it back to `renderEmailBodyHtml` and get the anchors out.
//
// Nothing is sent and nothing is written back to the sheet. This emits a plan for review; mailing
// it is a separate, approved step. That split is the point: the previous batch's damage came from
// generating and sending in one motion, so anything this cannot fill becomes a `needs` entry a
// human answers rather than a blank that ships.
//
// Deployment tokens (the Slack invite URL, the bot address) come from the environment, exactly as
// they do at send time. Unset, the draft still renders and those tokens stay visible.
import fs from "node:fs";
import { findOnboardingTemplate } from "../extensions/adminbot/src/workflows/onboarding/emails.ts";
import {
  composeOnboardingGuide,
  firstNameOf,
} from "../extensions/adminbot/src/workflows/onboarding/guide.ts";
import {
  findTaskRecommendation,
  renderTaskRecommendation,
} from "../extensions/adminbot/src/workflows/onboarding/task-recommendations.ts";
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

/** The tracking mailbox every lab mail is bcc'd to, per the template doc's global conventions. */
const TRACKING_BCC = "jinesis.adminbot@gmail.com";

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

// Free mailbox providers. A lead cc'd on mail to an applicant should be reachable at the address
// their institution gave them, not at a personal account that happens to be first in the row.
const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "protonmail.com",
  "proton.me",
  "qq.com",
  "163.com",
]);

function isInstitutional(address: string): boolean {
  return !FREEMAIL.has(address.split("@")[1]?.toLowerCase() ?? "");
}

/**
 * Everyone on the sheet, indexed by first name, for resolving the lead named in an applicant's
 * "Member Attributes" cell ("Andrew: AdminBot modular task", "Rahul, causal tutor human subject").
 *
 * The value is a list, not an address: two people can share a first name, and a cc sent to the
 * wrong one puts an applicant's file in front of somebody uninvolved. An ambiguous name resolves to
 * nothing and is reported instead.
 */
function directoryByFirstName(rows: readonly Row[]): Map<string, string[]> {
  const directory = new Map<string, string[]>();
  for (const row of rows.slice(1)) {
    const name = cell(row, NAME_COL);
    const first = name.split(/\s+/u)[0]?.toLowerCase();
    if (!first) {
      continue;
    }
    const addresses = addressesOf(row);
    const best = addresses.find(isInstitutional) ?? addresses[0];
    if (!best) {
      continue;
    }
    directory.set(first, [...(directory.get(first) ?? []), best]);
  }
  return directory;
}

/**
 * The leads named in a "Member Attributes" cell, as addresses.
 *
 * Matched on whole words against the sheet's own first names rather than on a hand-kept list of
 * leads, so a new lead works the day their row exists. Returns what could not be resolved so the
 * caller can report it rather than quietly cc nobody.
 */
export function leadsFromAttributes(
  attributes: string,
  directory: ReadonlyMap<string, string[]>,
): { cc: string[]; ambiguous: string[] } {
  const cc: string[] = [];
  const ambiguous: string[] = [];
  const seen = new Set<string>();
  for (const word of attributes.toLowerCase().match(/[a-z]+/gu) ?? []) {
    if (seen.has(word)) {
      continue;
    }
    seen.add(word);
    const found = directory.get(word);
    if (!found) {
      continue;
    }
    if (found.length > 1) {
      ambiguous.push(word);
      continue;
    }
    if (found[0] && !cc.includes(found[0])) {
      cc.push(found[0]);
    }
  }
  return { cc, ambiguous };
}

const URL_IN_TEXT = /https?:\/\/\S+/gu;

/**
 * The applicant's own application document, when the sheet carries it in "Member Attributes".
 *
 * Some rows have no form response at all -- the person applied by sending a document -- and for
 * those the link in the notes is the only thing that shows the lead what they wrote.
 *
 * Only a URL on a line that says "Student application" counts. Other rows carry links to the *task*
 * ("Bryan: word play RL as interviews" is followed by the WordPlay task doc), and forwarding a task
 * brief as though it were the applicant's file is the same class of mistake as forwarding the blank
 * form. Any further URLs are returned separately for the reviewer rather than chosen between.
 */
export function applicationLinksFromAttributes(attributes: string): {
  application?: string;
  others: string[];
} {
  let application: string | undefined;
  const others: string[] = [];
  for (const line of attributes.split("\n")) {
    const urls = line.match(URL_IN_TEXT) ?? [];
    const labelled = /student\s+application/iu.test(line);
    for (const url of urls) {
      const cleaned = url.replace(/[.,;)]+$/u, "");
      if (labelled && !application) {
        application = cleaned;
        continue;
      }
      others.push(cleaned);
    }
  }
  return { ...(application ? { application } : {}), others };
}

export type PlanEntry = {
  sheet_row: number;
  name: string;
  email: string;
  other_addresses?: string[];
  /** The project lead(s) the copy says are cc'd, resolved from the sheet. */
  cc: string[];
  /** Other URLs the row carries: a second application document, or a task brief. */
  other_links?: string[];
  /** Every lab mail is bcc'd to the tracking mailbox, per the template conventions. */
  bcc: string[];
  template_id: string;
  member_type?: string;
  also_named?: string[];
  values: Record<string, string>;
  /** Everything a human still has to supply before this can be sent. */
  needs: string[];
  note?: string;
  /** The mail as it stands. Any value still missing appears as a literal `{token}`. */
  subject: string;
  body: string;
};

/**
 * The draft for one entry, with unfilled values left visible as `{token}`.
 *
 * A plan you cannot read is a plan nobody checks, and the previous batch's mistakes -- a
 * recommendation naming the wrong work, a blank form link -- were all visible in the body and
 * invisible in the metadata. So every entry carries its mail, including the ones that are not ready
 * to send.
 *
 * `{token}` is passed as its own value for anything absent, which is what the send path's preview
 * already does: it satisfies the required-values check without resolving to anything, so the draft
 * renders and the gap stays legible instead of becoming a blank the eye slides over. `needs` is
 * still the authority on what is outstanding.
 */
function draftFor(
  templateId: string,
  values: Record<string, string>,
  env: NodeJS.ProcessEnv,
): { subject: string; body: string } {
  const template = findOnboardingTemplate(templateId);
  if (!template) {
    return { subject: "", body: "" };
  }
  const selfReferencing: Record<string, string> = { ...values };
  for (const token of template.required) {
    if (!selfReferencing[token]?.trim()) {
      selfReferencing[token] = `{${token}}`;
    }
  }
  const composed = composeOnboardingGuide(templateId, selfReferencing, env);
  if (composed.ok) {
    return { subject: composed.guide.subject, body: composed.guide.body };
  }
  // Unconfigured deployment tokens (no ADMINBOT_SLACK_INVITE_URL on this machine, say). Render what
  // we can by hand so the draft is still reviewable, and leave the rest as `{token}`.
  const fill = (text: string): string =>
    text.replace(/\{([a-z_]+)\}/gu, (whole, token: string) => selfReferencing[token] ?? whole);
  return {
    subject: fill(template.subject ?? ""),
    body: fill(template.body),
  };
}

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
/**
 * People to leave out of this batch, passed as `--exclude "<address or name>"`.
 *
 * A flag rather than an edit to the sheet: "not in this batch" is a decision about one run, while
 * the sheet records who someone is. Removing their row, or their Test Onboard mark, would lose that
 * -- and the next run would quietly mail them.
 */
export function parseExclusions(argv: readonly string[]): Set<string> {
  const excluded = new Set<string>();
  argv.forEach((arg, index) => {
    if (arg === "--exclude" && argv[index + 1]) {
      excluded.add((argv[index + 1] as string).trim().toLowerCase());
    }
  });
  return excluded;
}

function isExcluded(
  excluded: ReadonlySet<string>,
  name: string,
  addresses: readonly string[],
): boolean {
  return (
    excluded.has(name.trim().toLowerCase()) ||
    addresses.some((address) => excluded.has(address.trim().toLowerCase()))
  );
}

/**
 * Values that are the same for everyone in a run, passed as `--value <token>=<value>`.
 *
 * `portal_password` is the case this exists for: the lab hands every new member the same starting
 * password, but it is still a credential, so it is supplied per run rather than written into the
 * copy -- the same reason `emails.ts` keeps it as a placeholder instead of a literal.
 *
 * Applied as a fallback, never an override: anything the sheet or the form already provided wins,
 * so a batch-wide default cannot quietly replace a value that was set per person.
 */
export function parseSharedValues(argv: readonly string[]): Map<string, string> {
  const shared = new Map<string, string>();
  argv.forEach((arg, index) => {
    if (arg !== "--value") {
      return;
    }
    const pair = argv[index + 1] ?? "";
    const split = pair.indexOf("=");
    if (split > 0) {
      shared.set(pair.slice(0, split).trim(), pair.slice(split + 1));
    }
  });
  return shared;
}

function withSharedValues(
  values: Record<string, string>,
  shared: ReadonlyMap<string, string>,
): Record<string, string> {
  const merged = { ...values };
  for (const [token, value] of shared) {
    if (!merged[token]?.trim() && value.trim()) {
      merged[token] = value;
    }
  }
  return merged;
}

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
  env: NodeJS.ProcessEnv = process.env,
  formLinks: Readonly<Record<string, string>> = {},
  excluded: ReadonlySet<string> = new Set(),
  sharedValues: ReadonlyMap<string, string> = new Map(),
): Plan {
  const plan: Plan = {
    generated_at: new Date().toISOString(),
    direct_matching: [],
    test_onboard_3: [],
    skipped: [],
  };
  const [firstRow, lastRow] = matchingRange;
  const directory = directoryByFirstName(rows);

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
    if (isExcluded(excluded, cell(row, NAME_COL), addresses)) {
      plan.skipped.push({
        sheet_row: sheetRow,
        name: cell(row, NAME_COL) || (addresses[0] ?? ""),
        reason: "excluded from this batch by --exclude",
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
    // The applicant's own filled-in response, from `--form-links`. The Forms API cannot produce
    // this (see adminbot-form-response-links.ts), so an unmatched applicant is a `needs`.
    const fromAttributes = applicationLinksFromAttributes(attributes);
    const formLink = formLinks[(email ?? "").toLowerCase()] ?? fromAttributes.application;
    if (formLink) {
      values.application_form_link = formLink;
    } else {
      needs.push('application_form_link: this applicant\'s own "edit response" URL');
    }

    // The copy promises a cc'd project lead, so a mail with an empty cc contradicts its own text.
    // The sentence is the better source than the row's free text -- "AdminBot privacy logic" names
    // the task but nobody, while the sentence it maps to names Andrew -- so the recommendation's
    // own leads come first, and the row's notes add anyone else it mentions.
    const fromRecommendation = recommendationId
      ? (findTaskRecommendation(recommendationId)?.leads ?? []).join(" ")
      : "";
    const { cc, ambiguous } = leadsFromAttributes(
      `${fromRecommendation}\n${attributes}`,
      directory,
    );
    if (cc.length === 0) {
      needs.push(
        `cc: no project lead resolved from "${attributes.split("\n")[0] || "(no attributes)"}"`,
      );
    }
    for (const ambiguousName of ambiguous) {
      needs.push(`cc: "${ambiguousName}" matches more than one person on the sheet -- say which`);
    }

    plan.direct_matching.push({
      sheet_row: sheetRow,
      name: cell(row, NAME_COL),
      email: email ?? "",
      ...(others.length ? { other_addresses: others } : {}),
      template_id: "interview_invite_project_matching",
      ...(recommendationId
        ? { values: { ...values, recommendation: recommendationId } }
        : { values }),
      cc,
      bcc: [TRACKING_BCC],
      // Anything else the row links -- a second application document, a task brief -- so the
      // reviewer sees it rather than the parser choosing between them.
      ...(fromAttributes.others.length ? { other_links: fromAttributes.others } : {}),
      needs,
      ...(attributes ? { note: attributes } : {}),
      ...draftFor("interview_invite_project_matching", values, env),
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
    if (isExcluded(excluded, name, addresses)) {
      plan.skipped.push({
        sheet_row: sheetRow,
        name,
        reason: "excluded from this batch by --exclude",
      });
      continue;
    }
    const withShared = withSharedValues(values, sharedValues);
    const needs = needsFor(templateId, withShared);
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
      // A member's own onboarding names no lead, so cc is whoever their row happens to name and is
      // usually empty. Absence is not a `needs` here: unlike the applicant mail, this copy does not
      // promise anyone is copied.
      cc: leadsFromAttributes(cell(row, MEMBER_ATTRIBUTES_COL), directory).cc,
      bcc: [TRACKING_BCC],
      values: withShared,
      needs,
      // `first_name` is not in `values`: the send derives it from the recipient's name rather than
      // taking it from the form, so the draft has to derive it the same way to read correctly.
      ...draftFor(templateId, { ...withShared, first_name: firstNameOf(name) }, env),
    });
  }
  return plan;
}

function main(argv: readonly string[]): void {
  const rowsIndex = argv.indexOf("--rows");
  if (rowsIndex === -1 || !argv[rowsIndex + 1]) {
    console.error(
      'usage: --rows <rows.json> [--matches <matches.json>] [--out <plan.json>] [--form-links <links.json>] [--exclude "<name or address>"]... [--value <token>=<value>]... [--matching-rows <first>-<last>] [--email "Name=addr@example"]...',
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
  const linksIndex = argv.indexOf("--form-links");
  const formLinks: Record<string, string> =
    linksIndex === -1 || !argv[linksIndex + 1]
      ? {}
      : (JSON.parse(fs.readFileSync(argv[linksIndex + 1] as string, "utf8")) as Record<
          string,
          string
        >);
  const plan = buildPlan(
    rows,
    [first as number, last as number],
    matches,
    parseEmailOverrides(argv),
    process.env,
    formLinks,
    parseExclusions(argv),
    parseSharedValues(argv),
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
