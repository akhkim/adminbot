// Sends the full-member onboarding mail to every full member who was not part of a test-onboarding
// batch.
//
//   node --import tsx scripts/adminbot-send-full-member-onboarding-batch.ts <db> <export.csv> [flags]
//
// Flags: --send, --only <name-substring>, --log <path>
//
// Selection: column S ("Member Type") lists "full" as one of its comma-separated roles, and column
// R ("Test Onboard") is not 1, 2 or 3. This replaced an earlier sender that keyed only on "has an
// account they have never used", which mailed people who had already been onboarded in a test
// batch and needed a second flag to reach members with no credential at all.
//
// Two further exclusions, both about not mailing a welcome to someone already settled in:
//
//   - Anyone whose credential no longer verifies against the seeded password has signed in and
//     chosen their own, so the mail's "temporary password" instructions would be wrong for them.
//     Members with no credential at all are still mailed: they have no @cs.toronto.edu address
//     yet, and the mail's second branch is written for exactly that case.
//   - The PI and the lab admin who runs this batch, who are both typed `full` on the sheet but do
//     not need onboarding from their own tooling.
//
// Dry run by default: every message is written to .artifacts/onboarding-mail-batch/ and nothing
// leaves the machine. `--send` is the only thing that mails, and it needs GOG_KEYRING_PASSWORD in
// the environment because gog's token sits in a file keyring.
//
// Sends are logged to .artifacts/onboarding-mail-batch/sent.log as they succeed, and anyone in
// that log is skipped on a later run. A batch that dies halfway is resumed by re-running the same
// command rather than by working out where it stopped.
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { renderEmailBodyHtml } from "../extensions/adminbot/src/connectors/email-html.ts";
import { verifyPassword } from "../extensions/adminbot/src/workflows/identity/auth.ts";
import { composeOnboardingGuide } from "../extensions/adminbot/src/workflows/onboarding/guide.ts";
import { parseCsv } from "./adminbot-import-member-sheet.ts";

const execFile = promisify(execFileCallback);
const TEMPLATE_ID = "member";
const SEEDED_PASSWORD = "jinesis";
const OUT_DIR = ".artifacts/onboarding-mail-batch";
const MEMBER_TYPE_HEADER = "Member Type";
const TEST_ONBOARD_HEADER = "Test Onboard";
const CORRESPONDENCE_HEADER = "Email for correspondence (the more professional the better)";
const SLACK_ID_HEADER = "Slack ID";
// The test-onboarding batches that have already been mailed.
const EXCLUDED_TEST_GROUPS = new Set(["1", "2", "3"]);
// Typed `full` on the sheet, but not recipients: the PI, and the lab admin who runs this batch.
const EXCLUDED_NAMES = new Set(["zhijing jin", "andrew kim"]);
// gog's own tracking address. Every lab mail is bcc'd there per the template conventions.
const TRACKING_BCC = "jinesis.adminbot@gmail.com";

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** First word of the name, which is what the template's greeting takes. */
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? name.trim();
}

/** "full, coauthor-major" lists full as a role; a hypothetical "full-time-equivalent" does not. */
function isFullMember(cell: string): boolean {
  return cell
    .split(",")
    .map((role) => role.trim().toLowerCase())
    .includes("full");
}

/**
 * The one address to write to, from a cell that sometimes holds two.
 *
 * Several rows carry "a@x / b@y" or "a@x / b@y (preferred for calendar invites)". Where the cell
 * offers a choice the personal Gmail wins: it is the address that survives a change of
 * institution, which is the whole reason those rows list two. With one address there is no choice
 * to make and it is used as written.
 */
function correspondenceAddress(cell: string): string | undefined {
  const candidates = cell
    .split("/")
    .map((part) =>
      part
        .replace(/\s*\(.*$/u, "")
        .trim()
        .toLowerCase(),
    )
    .filter((part) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u.test(part));
  return candidates.find((address) => address.endsWith("@gmail.com")) ?? candidates[0];
}

type Recipient = { name: string; to: string; memberType: string };

/** Member ids whose credential still verifies against the seeded password, plus those with none. */
function loadNeverSignedIn(databasePath: string): {
  idFor: (slackId: string, name: string) => string | undefined;
  hasOwnPassword: (memberId: string | undefined) => boolean;
} {
  const db = new DatabaseSync(databasePath);
  try {
    const members = (
      db.prepare("SELECT id, payload_json FROM adminbot_lab_members").all() as unknown as Array<{
        id: string;
        payload_json: string;
      }>
    ).map((row) => ({
      id: row.id,
      member: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
    const bySlack = new Map(
      members
        .filter((row) => String(row.member.slack_user_id ?? "").trim())
        .map((row) => [String(row.member.slack_user_id).trim(), row.id]),
    );
    const byName = new Map(
      members.map((row) => [normalizeName(String(row.member.name ?? "")), row.id]),
    );
    const credentials = new Map(
      (
        db
          .prepare("SELECT member_id, password_scrypt FROM adminbot_member_credentials")
          .all() as unknown as Array<{
          member_id: string;
          password_scrypt: string;
        }>
      ).map((row) => [row.member_id, row.password_scrypt]),
    );
    return {
      idFor: (slackId, name) => bySlack.get(slackId.trim()) ?? byName.get(normalizeName(name)),
      // No credential means no account yet, which the mail covers -- only a changed password is a
      // reason to stay silent.
      hasOwnPassword: (memberId) => {
        const scrypt = memberId ? credentials.get(memberId) : undefined;
        return scrypt !== undefined && !verifyPassword(scrypt, SEEDED_PASSWORD);
      },
    };
  } finally {
    db.close();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const onlyAt = args.indexOf("--only");
  const only = onlyAt < 0 ? undefined : args[onlyAt + 1]?.toLowerCase();
  const logAt = args.indexOf("--log");
  const logPath = (logAt < 0 ? undefined : args[logAt + 1]) ?? path.join(OUT_DIR, "sent.log");
  const flagValues = new Set([only, logAt < 0 ? undefined : args[logAt + 1]].filter(Boolean));
  const [databasePath, csvPath] = args.filter(
    (arg) => !arg.startsWith("--") && !flagValues.has(arg.toLowerCase()) && !flagValues.has(arg),
  );
  if (!databasePath || !csvPath) {
    throw new Error(
      "usage: adminbot-send-full-member-onboarding-batch.ts <db> <export.csv> [--send]",
    );
  }
  if (send && !process.env.GOG_KEYRING_PASSWORD) {
    throw new Error("--send needs GOG_KEYRING_PASSWORD; gog cannot read its token without it");
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8").replace(/^﻿/u, ""));
  const header = rows[0] ?? [];
  const at = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) {
      throw new Error(`export is missing the "${name}" column`);
    }
    return index;
  };
  const typeAt = at(MEMBER_TYPE_HEADER);
  const testAt = at(TEST_ONBOARD_HEADER);
  const corrAt = at(CORRESPONDENCE_HEADER);
  const slackAt = at(SLACK_ID_HEADER);
  const accounts = loadNeverSignedIn(databasePath);

  // Addresses already mailed by an earlier run of this batch.
  const alreadySent = new Set(
    fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, "utf8")
          .split("\n")
          .map((line) => line.split("\t")[1]?.trim().toLowerCase())
          .filter((address): address is string => Boolean(address))
      : [],
  );

  const recipients: Recipient[] = [];
  const skips: string[] = [];
  for (const row of rows.slice(1)) {
    const name = (row[0] ?? "").trim();
    if (!name || !isFullMember(row[typeAt] ?? "")) {
      continue;
    }
    if (EXCLUDED_NAMES.has(normalizeName(name))) {
      skips.push(`${name}: excluded by name (PI / lab admin)`);
      continue;
    }
    const testGroup = (row[testAt] ?? "").trim();
    if (EXCLUDED_TEST_GROUPS.has(testGroup)) {
      skips.push(`${name}: test-onboarding group ${testGroup}`);
      continue;
    }
    if (accounts.hasOwnPassword(accounts.idFor(row[slackAt] ?? "", name))) {
      skips.push(`${name}: already signed in and set their own password`);
      continue;
    }
    const to = correspondenceAddress(row[corrAt] ?? "");
    if (!to) {
      skips.push(`${name}: no usable address in the correspondence column`);
      continue;
    }
    if (alreadySent.has(to)) {
      skips.push(`${name}: already mailed by an earlier run (${to})`);
      continue;
    }
    if (only && !name.toLowerCase().includes(only)) {
      continue;
    }
    recipients.push({ name, to, memberType: (row[typeAt] ?? "").trim() });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const composed = recipients.map((recipient) => {
    const result = composeOnboardingGuide(TEMPLATE_ID, { first_name: firstNameOf(recipient.name) });
    if (!result.ok) {
      throw new Error(`${recipient.name}: ${result.reason} ${result.missing.join(", ")}`);
    }
    return { recipient, subject: result.guide.subject, body: result.guide.body };
  });

  console.log(`recipients: ${composed.length}`);
  for (const entry of composed) {
    const extra = entry.recipient.memberType === "full" ? "" : `  (${entry.recipient.memberType})`;
    console.log(`  ${entry.recipient.name.padEnd(26)} -> ${entry.recipient.to}${extra}`);
    fs.writeFileSync(
      path.join(OUT_DIR, `${entry.recipient.to.replace(/[^a-z0-9]+/gu, "-")}.txt`),
      `To: ${entry.recipient.to}\nBcc: ${TRACKING_BCC}\nSubject: ${entry.subject}\n\n${entry.body}\n`,
    );
  }
  if (skips.length) {
    console.log(`\nskipped (${skips.length}):`);
    for (const skip of skips) {
      console.log(`  ${skip}`);
    }
  }
  console.log(`\nmessages written to ${OUT_DIR}/`);

  if (!send) {
    console.log("Dry run. Re-run with --send to mail them.");
    return;
  }

  void (async () => {
    let sent = 0;
    for (const entry of composed) {
      // One at a time, and a failure stops the run. The log line is written before the next send
      // starts, so a crash leaves an accurate record of what has already gone out.
      await execFile("gog", [
        "gmail",
        "send",
        "--to",
        entry.recipient.to,
        "--bcc",
        TRACKING_BCC,
        "--subject",
        entry.subject,
        "--body",
        entry.body,
        "--body-html",
        renderEmailBodyHtml(entry.body),
      ]);
      fs.appendFileSync(
        logPath,
        `${new Date().toISOString()}\t${entry.recipient.to}\t${entry.recipient.name}\n`,
      );
      sent += 1;
      console.log(`sent ${sent}/${composed.length}: ${entry.recipient.to}`);
    }
    console.log(`\nSent ${sent}. Log: ${logPath}`);
  })();
}

main();
