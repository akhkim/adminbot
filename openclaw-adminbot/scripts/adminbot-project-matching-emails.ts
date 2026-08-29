// Builds, and optionally sends, the "direct project matching" mail: the note to an applicant whose
// form response Zhijing has read and routed to a project lead.
//
//   node --import tsx scripts/adminbot-project-matching-emails.ts <export.csv> [flags]
//
// Flags:
//   --form-links <path>  jinesis-form-response-links.json (see scripts/jinesis-form-response-links.gs)
//   --rows 169-182       restrict to a sheet row range; repeatable
//   --only <substring>   restrict to addresses containing this
//   --exclude <a,b>      drop these addresses
//   --json <path>        where to write the review file (default .artifacts/project-matching/emails.json)
//   --send               actually mail them
//   --log <path>         sent log, for resuming a batch that died halfway
//
// Selection. A row belongs to this group when it has an address, column T (Member Attributes)
// carries a matching note, and column R (Test Onboard) is blank -- the onboarding batches are a
// different flow with different templates. Column T is also what names the lead: it is written as
// "Andrew: AdminBot modular task" or "Rahul, causal tutor human subject first", so the first names
// appearing in it are looked up against the sheet's own roster. Lead addresses are therefore never
// hardcoded here; add a lead to the sheet and this finds them.
//
// The link. Each applicant gets a link to their *own* application and nothing else, because the
// mail cc's the lead: a link to the blank form shows nobody's answers and a link to the response
// sheet shows everybody's. Two sources, in order:
//   1. their own form response, from --form-links (a .../viewform?edit2=<token> URL, which opens
//      for non-owners because the token is the grant);
//   2. a "Student application:" document on their own row, for applicants who applied by document.
// A row carrying several applicants AND several documents is never auto-paired -- order on the
// sheet has been wrong before, and pairing by position mailed one applicant another's file. Those
// are emitted with no link and flagged; a human pairs them by opening the documents.
//
// Dry run by default: everything is written to the review JSON and nothing leaves the machine.
// `--send` needs GOG_KEYRING_PASSWORD, since gog's token sits in a file keyring.
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { renderEmailBodyHtml } from "../extensions/adminbot/src/connectors/email-html.ts";
import { composeOnboardingGuide } from "../extensions/adminbot/src/workflows/onboarding/guide.ts";
import { AdminBotEmailModel } from "./adminbot-email-model.ts";
import { parseCsv } from "./adminbot-import-member-sheet.ts";

const execFile = promisify(execFileCallback);

export const TEMPLATE_ID = "interview_invite_project_matching";
const OUT_DIR = ".artifacts/project-matching";
// Replies must reach a person. AdminBot sends from a mailbox nobody reads, and this mail invites a
// reply in as many words ("they will reply to this email thread").
export const REPLY_TO = "akim@cs.toronto.edu";

const NAME_HEADER = "Name";
const CORRESPONDENCE_HEADER = "Email for correspondence (the more professional the better)";
const SLACK_EMAIL_HEADER = "Slack email";
const TEST_ONBOARD_HEADER = "Test Onboard";
const ATTRIBUTES_HEADER = "Member Attributes";
const INTERESTS_HEADER = "Research interests";
const TLDR_HEADER = "tldr";

/** A lab member who can be named as a project lead, indexed by the first name column T uses. */
export type Lead = { firstName: string; name: string; email: string };

export type MatchRow = {
  sheetRow: number;
  /** One draft per applicant: a row's Slack-email cell may list several. */
  email: string;
  otherAddresses: string[];
  note: string;
  leads: Lead[];
  /** How the leads were found: named in column T, or via the project map. */
  leadsVia: "named" | "project" | "none";
  applicationLink?: string;
  otherLinks: string[];
  taskDocLink?: string;
  tldr?: string;
  researchInterests?: string;
  needs: string[];
};

const DOC_URL = /https:\/\/docs\.google\.com\/document\/\S+/gu;

export function addressesIn(cell: string): string[] {
  return cell
    .split(/[\n,;]/u)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.includes("@"));
}

/**
 * Every member the sheet knows, keyed by first name.
 *
 * Column Q (the CS Toronto address) wins over column E: a lead cc'd on lab correspondence is
 * reached at their lab address, and several leads have a personal address in E that they do not
 * use for this.
 */
export function buildLeadIndex(
  rows: string[][],
  nameAt: number,
  corrAt: number,
  slackAt: number,
): Map<string, Lead> {
  const index = new Map<string, Lead>();
  for (const row of rows) {
    const name = (row[nameAt] ?? "").trim();
    if (!name) {
      continue;
    }
    const email = addressesIn(row[slackAt] ?? "")[0] ?? addressesIn(row[corrAt] ?? "")[0];
    if (!email) {
      continue;
    }
    const firstName = name.split(/\s+/u)[0]!.toLowerCase();
    // First occurrence wins: the sheet is ordered with the lab's own people at the top, so a later
    // namesake among the applicants cannot displace a lead.
    if (!index.has(firstName)) {
      index.set(firstName, { firstName, name, email });
    }
  }
  return index;
}

/**
 * Which lead owns a project, for the rows that name only the work.
 *
 * Column T is often just "AdminBot" or "AdminBot privacy logic" with no name in it, because the
 * lab knows whose project that is. This is that knowledge written down. It is not on the sheet:
 * "Projects Open for Colab" has a Contact column but does not list these projects, so there is
 * nothing to read it from. Keep it in step with the lab, or override it for a run with
 * `--project-leads <json>` mapping project keyword to lead first name.
 */
export const PROJECT_LEADS: Record<string, string> = {
  adminbot: "andrew",
  "career launch": "andrew",
  causaltutor: "rahul",
  "causal tutor": "rahul",
  cladder: "rahul",
  wordplay: "bryan",
  "word play": "bryan",
};

export type LeadResolution = { leads: Lead[]; via: "named" | "project" | "none" };

/**
 * The leads column T points at, in the order it points at them, so a numbered sentence follows
 * the note's own order.
 *
 * A name in the note always wins over the project map: "Rahul: CLadder leaderboard" is Rahul's
 * whatever the map says, and a note that reassigns a project must not be overridden by it.
 */
export function resolveLeads(
  note: string,
  index: Map<string, Lead>,
  projectLeads: Record<string, string> = PROJECT_LEADS,
): LeadResolution {
  const lower = note.toLowerCase();
  const found: { lead: Lead; at: number }[] = [];
  for (const [firstName, lead] of index) {
    // Word-boundary match: "Kem," and "Kem:" count, "Kemal" does not.
    const at = lower.search(new RegExp(`\\b${firstName}\\b`, "u"));
    if (at >= 0) {
      found.push({ lead, at });
    }
  }
  if (found.length > 0) {
    return {
      leads: found.toSorted((a, b) => a.at - b.at).map((entry) => entry.lead),
      via: "named",
    };
  }

  const byProject: { lead: Lead; at: number }[] = [];
  for (const [keyword, firstName] of Object.entries(projectLeads)) {
    const at = lower.indexOf(keyword);
    const lead = index.get(firstName);
    if (at >= 0 && lead && !byProject.some((entry) => entry.lead.email === lead.email)) {
      byProject.push({ lead, at });
    }
  }
  if (byProject.length > 0) {
    return {
      leads: byProject.toSorted((a, b) => a.at - b.at).map((entry) => entry.lead),
      via: "project",
    };
  }
  return { leads: [], via: "none" };
}

/** A task doc the lead already holds, as opposed to an applicant's own application document. */
export function taskDocIn(note: string): string | undefined {
  const applicationAt = note.toLowerCase().indexOf("student application");
  const docs = [...note.matchAll(DOC_URL)].map((match) => match[0]);
  if (docs.length === 0) {
    return undefined;
  }
  // Anything after "Student application:" belongs to the applicant, not to the lead.
  return applicationAt >= 0 ? undefined : docs[0];
}

export function applicationDocsIn(note: string): string[] {
  const applicationAt = note.toLowerCase().indexOf("student application");
  if (applicationAt < 0) {
    return [];
  }
  return [...note.slice(applicationAt).matchAll(DOC_URL)].map((match) => match[0]);
}

/**
 * Turns one sheet row into one draft per applicant on it.
 *
 * Exported for the tests: the pairing rule below is the part that has gone wrong in practice, and
 * it is worth being able to assert on directly.
 */
export function rowToMatches(options: {
  sheetRow: number;
  addresses: string[];
  note: string;
  leads: Lead[];
  leadsVia: "named" | "project" | "none";
  formLinks: Map<string, string>;
  tldr?: string;
  researchInterests?: string;
}): MatchRow[] {
  const { sheetRow, addresses, note, leads, leadsVia, formLinks } = options;
  const docs = applicationDocsIn(note);
  const taskDocLink = taskDocIn(note);

  return addresses.map((email, position) => {
    const needs: string[] = [];
    let applicationLink = formLinks.get(email);
    let otherLinks: string[] = [];

    if (!applicationLink && docs.length > 0) {
      if (addresses.length === 1) {
        applicationLink = docs[0];
        otherLinks = docs.slice(1);
      } else if (docs.length === 1) {
        // One document but several applicants: it cannot belong to all of them.
        needs.push(
          `row lists ${addresses.length} applicants and one application document; it is not clear `
            + "whose it is, so no link is set",
        );
      } else {
        // Several of each. Pairing by position is exactly the mistake that once sent an applicant
        // somebody else's application, so this refuses rather than guesses.
        needs.push(
          `row lists ${addresses.length} applicants and ${docs.length} application documents with `
            + "no stated pairing; open each document and set application_form_link by the name "
            + "inside it",
        );
        otherLinks = docs;
      }
    }
    if (!applicationLink && docs.length === 0) {
      needs.push("no response to the application form under this address, and no application "
        + "document on the row");
    }
    if (leads.length === 0) {
      needs.push("column T names no lead and matches no project in the project map; nobody "
        + "would be cc'd");
    }

    return {
      sheetRow,
      email,
      otherAddresses: addresses.filter((_, index) => index !== position),
      note,
      leads,
      leadsVia,
      applicationLink,
      otherLinks,
      taskDocLink,
      tldr: options.tldr,
      researchInterests: options.researchInterests,
      needs,
    };
  });
}

function parseRowRanges(values: string[]): (row: number) => boolean {
  if (values.length === 0) {
    return () => true;
  }
  const ranges = values.flatMap((value) =>
    value.split(",").map((part) => {
      const [from, to] = part.split("-").map((n) => Number.parseInt(n.trim(), 10));
      return { from: from!, to: Number.isFinite(to!) ? to! : from! };
    }),
  );
  return (row) => ranges.some((range) => row >= range.from && row <= range.to);
}

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((arg, index) => {
    if (arg === flag && args[index + 1]) {
      out.push(args[index + 1]!);
    }
  });
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const only = flagValue(args, "--only")?.toLowerCase();
  const excluded = new Set(
    (flagValue(args, "--exclude") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const inRange = parseRowRanges(flagValues(args, "--rows"));
  const jsonPath = flagValue(args, "--json") ?? path.join(OUT_DIR, "emails.json");
  const logPath = flagValue(args, "--log") ?? path.join(OUT_DIR, "sent.log");
  const formLinksPath = flagValue(args, "--form-links");
  const projectLeadsPath = flagValue(args, "--project-leads");
  const projectLeads = projectLeadsPath
    ? (JSON.parse(fs.readFileSync(projectLeadsPath, "utf8")) as Record<string, string>)
    : PROJECT_LEADS;

  const taken = new Set(
    ["--only", "--exclude", "--json", "--log", "--form-links", "--rows", "--project-leads"].flatMap((flag) =>
      flagValues(args, flag),
    ),
  );
  const csvPath = args.find((arg) => !arg.startsWith("--") && !taken.has(arg));
  if (!csvPath) {
    throw new Error("usage: adminbot-project-matching-emails.ts <export.csv> [--send]");
  }
  if (send && !process.env.GOG_KEYRING_PASSWORD) {
    throw new Error("--send needs GOG_KEYRING_PASSWORD; gog cannot read its token without it");
  }

  const formLinks = new Map<string, string>();
  if (formLinksPath) {
    const payload = JSON.parse(fs.readFileSync(formLinksPath, "utf8")) as {
      links?: Record<string, string>;
    };
    for (const [address, url] of Object.entries(payload.links ?? {})) {
      formLinks.set(address.trim().toLowerCase(), url.trim());
    }
  } else {
    console.warn("no --form-links: applicants who used the form will have no application link");
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8").replace(/^﻿/u, ""));
  const header = rows[0] ?? [];
  const at = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) {
      throw new Error(`export is missing the "${name}" column`);
    }
    return index;
  };
  // The name column is the sheet's first and is sometimes unlabelled in an export.
  const nameAt = header.indexOf(NAME_HEADER) < 0 ? 0 : header.indexOf(NAME_HEADER);
  const corrAt = at(CORRESPONDENCE_HEADER);
  const slackAt = at(SLACK_EMAIL_HEADER);
  const testAt = at(TEST_ONBOARD_HEADER);
  const noteAt = at(ATTRIBUTES_HEADER);
  const interestsAt = header.indexOf(INTERESTS_HEADER);
  const tldrAt = header.indexOf(TLDR_HEADER);

  const leadIndex = buildLeadIndex(rows.slice(1), nameAt, corrAt, slackAt);

  const alreadySent = new Set(
    fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, "utf8")
          .split("\n")
          .map((line) => line.split("\t")[1]?.trim().toLowerCase())
          .filter((value): value is string => Boolean(value))
      : [],
  );

  const matches: MatchRow[] = [];
  const skipped: { sheetRow: number; reason: string }[] = [];
  rows.slice(1).forEach((row, index) => {
    const sheetRow = index + 2; // header is row 1
    const note = (row[noteAt] ?? "").trim();
    if (!note) {
      return;
    }
    if ((row[testAt] ?? "").trim()) {
      skipped.push({ sheetRow, reason: `Test Onboard is ${row[testAt]!.trim()}: an onboarding batch, not this flow` });
      return;
    }
    if (!inRange(sheetRow)) {
      return;
    }
    const addresses = [
      ...new Set([...addressesIn(row[slackAt] ?? ""), ...addressesIn(row[corrAt] ?? "")]),
    ];
    if (addresses.length === 0) {
      skipped.push({ sheetRow, reason: `no address on this row (note: ${note.slice(0, 80)})` });
      return;
    }
    const resolution = resolveLeads(note, leadIndex, projectLeads);
    matches.push(
      ...rowToMatches({
        sheetRow,
        addresses,
        note,
        leads: resolution.leads,
        leadsVia: resolution.via,
        formLinks,
        tldr: tldrAt >= 0 ? (row[tldrAt] ?? "").trim() || undefined : undefined,
        researchInterests:
          interestsAt >= 0 ? (row[interestsAt] ?? "").trim() || undefined : undefined,
      }),
    );
  });

  const selected = matches.filter((match) => {
    if (excluded.has(match.email)) {
      skipped.push({ sheetRow: match.sheetRow, reason: `${match.email} excluded by --exclude` });
      return false;
    }
    if (alreadySent.has(match.email)) {
      skipped.push({ sheetRow: match.sheetRow, reason: `${match.email} mailed by an earlier run` });
      return false;
    }
    return only ? match.email.includes(only) : true;
  });

  const model = new AdminBotEmailModel();
  const drafts = [];
  for (const match of selected) {
    let recommendation: string | undefined;
    let recommendationError: string | undefined;
    try {
      recommendation = (
        await model.projectMatch({
          matchingNote: match.note,
          leadFirstNames: match.leads.map((lead) => lead.firstName),
          taskDocLink: match.taskDocLink,
          tldr: match.tldr,
          researchInterests: match.researchInterests,
        })
      ).recommendation;
    } catch (error) {
      recommendationError = error instanceof Error ? error.message : String(error);
    }

    const needs = [...match.needs];
    if (recommendationError) {
      needs.push(`recommendation not written: ${recommendationError}`);
    }

    let subject: string | undefined;
    let body: string | undefined;
    if (recommendation && match.applicationLink) {
      const composed = composeOnboardingGuide(TEMPLATE_ID, {
        application_form_link: match.applicationLink,
        task_recommendation: recommendation,
      });
      if (composed.ok) {
        ({ subject, body } = { subject: composed.guide.subject, body: composed.guide.body });
      } else {
        needs.push(`could not compose: ${composed.reason} ${composed.missing.join(", ")}`);
      }
    }

    drafts.push({
      sheet_row: match.sheetRow,
      email: match.email,
      other_addresses: match.otherAddresses,
      template_id: TEMPLATE_ID,
      cc: match.leads.map((lead) => lead.email),
      cc_resolved_via: match.leadsVia,
      reply_to: REPLY_TO,
      values: {
        application_form_link: match.applicationLink,
        task_recommendation: recommendation,
      },
      other_links: match.otherLinks,
      note: match.note,
      needs,
      subject,
      body,
      ready: Boolean(subject && body && needs.length === 0),
    });
  }

  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      { generated_at: new Date().toISOString(), reply_to: REPLY_TO, direct_matching: drafts, skipped },
      null,
      2,
    )}\n`,
  );

  const ready = drafts.filter((draft) => draft.ready);
  console.log(`drafts: ${drafts.length}  ready: ${ready.length}`);
  for (const draft of drafts) {
    const flag = draft.ready ? "  " : "! ";
    const via = draft.cc_resolved_via === "project" ? " (lead from the project map)" : "";
    console.log(
      `${flag}row ${draft.sheet_row} ${draft.email} -> cc ${draft.cc.join(", ") || "(none)"}${via}`,
    );
    for (const need of draft.needs) {
      console.log(`      ${need}`);
    }
  }
  console.log(`\nreview file: ${jsonPath}`);

  if (!send) {
    console.log("Dry run. Re-run with --send to mail the ready ones.");
    return;
  }
  if (ready.length !== drafts.length) {
    throw new Error(
      `${drafts.length - ready.length} draft(s) are not ready; fix or --exclude them before sending`,
    );
  }

  let sent = 0;
  for (const draft of ready) {
    await execFile("gog", [
      "gmail",
      "send",
      "--to",
      draft.email,
      ...(draft.cc.length > 0 ? ["--cc", draft.cc.join(",")] : []),
      "--reply-to",
      REPLY_TO,
      "--subject",
      draft.subject!,
      "--body",
      draft.body!,
      "--body-html",
      renderEmailBodyHtml(draft.body!),
    ]);
    // Written before the next send starts, so a crash leaves an accurate record.
    fs.appendFileSync(logPath, `${new Date().toISOString()}\t${draft.email}\trow ${draft.sheet_row}\n`);
    sent += 1;
    console.log(`sent ${sent}/${ready.length}: ${draft.email}`);
  }
  console.log(`\nSent ${sent}. Log: ${logPath}`);
}

if (process.argv[1]?.endsWith("adminbot-project-matching-emails.ts")) {
  await main();
}
