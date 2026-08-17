// Sends the full-member onboarding mail to the people who have an account they have never used.
//
//   node --import tsx scripts/adminbot-send-full-member-onboarding.ts <db> <export.csv> [flags]
//
// Flags: --send, --no-account
//
// Dry run by default: every message is written to .artifacts/onboarding-mail/ and nothing leaves
// the machine. `--send` is the only thing that mails, and it needs GOG_KEYRING_PASSWORD in the
// environment because gog's token sits in a file keyring.
//
// Who gets it, by default: column S ("Member Type") contains "full", and the member's credential
// still verifies against the seeded password -- meaning the account was created for them and they
// have never signed in. Someone who has set their own password is not told to use a temporary one.
//
// `--no-account` selects the other group: full members with no credential at all, because they
// have no @cs.toronto.edu address to sign in with. The same mail reads correctly for them -- its
// second branch is the one that applies -- and this mode also files each person's DCS Slack-access
// request, which is what produces the address they will later claim their account with.
//
// Delivery goes to column E ("Email for correspondence"), which is frequently not the address the
// account signs in with -- that one is the @cs.toronto.edu address the mail describes.
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { renderEmailBodyHtml } from "../extensions/adminbot/src/connectors/email-html.ts";
import { composeOnboardingGuide } from "../extensions/adminbot/src/workflows/onboarding/guide.ts";
import { verifyPassword } from "../extensions/adminbot/src/workflows/identity/auth.ts";
import { normalizeSheetValue, parseCsv } from "./adminbot-import-member-sheet.ts";

const execFile = promisify(execFileCallback);
const SEEDED_PASSWORD = "jinesis";
const DCS_FORM_SCRIPT = "scripts/adminbot-dcs-form-submit.ts";
const TEMPLATE_ID = "member";
const OUT_DIR = ".artifacts/onboarding-mail";
const MEMBER_TYPE_HEADER = "Member Type";
const CORRESPONDENCE_HEADER = "Email for correspondence (the more professional the better)";
const SLACK_ID_HEADER = "Slack ID";
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

/**
 * The one address to write to, from a cell that sometimes holds two.
 *
 * Several rows carry "a@x / b@y" or "a@x / b@y (preferred for calendar invites)". Splitting on the
 * separator and taking the first is what a person reading the sheet would do; the alternative is
 * mailing a string that is not an address at all.
 */
function correspondenceAddress(cell: string): string | undefined {
  const first = cell.split("/")[0]?.trim() ?? "";
  const address = first.replace(/\s*\(.*$/u, "").trim().toLowerCase();
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u.test(address) ? address : undefined;
}

type Recipient = { memberId: string; name: string; to: string; login: string };

function main(): void {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const noAccount = args.includes("--no-account");
  const [databasePath, csvPath] = args.filter((arg) => !arg.startsWith("--"));
  if (!databasePath || !csvPath) {
    throw new Error("usage: adminbot-send-full-member-onboarding.ts <db> <export.csv> [--send]");
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
  const corrAt = at(CORRESPONDENCE_HEADER);
  const slackAt = at(SLACK_ID_HEADER);

  const db = new DatabaseSync(databasePath);
  const members = (
    db.prepare("SELECT id, payload_json FROM adminbot_lab_members").all() as unknown as Array<{
      id: string;
      payload_json: string;
    }>
  ).map((row) => ({ id: row.id, member: JSON.parse(row.payload_json) as Record<string, unknown> }));
  const bySlack = new Map(
    members
      .filter((row) => String(row.member.slack_user_id ?? "").trim())
      .map((row) => [String(row.member.slack_user_id).trim(), row.id]),
  );
  const byName = new Map(members.map((row) => [normalizeName(String(row.member.name ?? "")), row.id]));
  const credentials = new Map(
    (
      db.prepare("SELECT member_id, email, password_scrypt FROM adminbot_member_credentials").all() as unknown as Array<{
        member_id: string;
        email: string;
        password_scrypt: string;
      }>
    ).map((row) => [row.member_id, row]),
  );

  const recipients: Recipient[] = [];
  const skips: string[] = [];
  for (const row of rows.slice(1)) {
    const name = (row[0] ?? "").trim();
    if (!name || !(row[typeAt] ?? "").toLowerCase().includes("full")) {
      continue;
    }
    const memberId = bySlack.get((row[slackAt] ?? "").trim()) ?? byName.get(normalizeName(name));
    const credential = memberId ? credentials.get(memberId) : undefined;
    if (noAccount) {
      if (credential) {
        skips.push(`${name}: already has an account`);
        continue;
      }
    } else if (!credential) {
      skips.push(`${name}: no account — run with --no-account for this group`);
      continue;
    } else if (!verifyPassword(credential.password_scrypt, SEEDED_PASSWORD)) {
      skips.push(`${name}: already signed in and set their own password`);
      continue;
    }
    const to = correspondenceAddress(row[corrAt] ?? "");
    if (!to) {
      skips.push(`${name}: no usable address in the correspondence column`);
      continue;
    }
    recipients.push({ memberId: memberId!, name, to, login: credential?.email ?? "(no account yet)" });
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
    const differs = entry.recipient.to === entry.recipient.login ? "" : `  (signs in as ${entry.recipient.login})`;
    console.log(`  ${entry.recipient.name.padEnd(26)} -> ${entry.recipient.to}${differs}`);
    fs.writeFileSync(
      path.join(OUT_DIR, `${entry.recipient.memberId}.txt`),
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
  db.close();

  if (!send) {
    console.log("Dry run. Re-run with --send to mail them.");
    return;
  }

  void (async () => {
    let sent = 0;
    for (const entry of composed) {
      // One at a time, and a failure stops the run: half a batch delivered is recoverable only if
      // you know exactly where it stopped.
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
      sent += 1;
      console.log(`sent ${sent}/${composed.length}: ${entry.recipient.to}`);

      // Only for the no-account group: the mail told them an account request is coming, and this
      // is that request. Reported and not thrown -- the mail has gone, so a failed form is a
      // follow-up item rather than a reason to abandon the rest of the batch.
      if (noAccount) {
        const [firstName = entry.recipient.name, ...rest] = entry.recipient.name.split(/\s+/u);
        const lastName = rest.join(" ") || firstName;
        try {
          await execFile("node", [
            "--import",
            "tsx",
            DCS_FORM_SCRIPT,
            JSON.stringify({ firstName, lastName, email: entry.recipient.to }),
          ]);
          console.log(`     DCS request filed for ${entry.recipient.name}`);
        } catch (error) {
          console.log(
            `     DCS request FAILED for ${entry.recipient.name}: ${
              error instanceof Error ? error.message.split("\n")[0] : String(error)
            }`,
          );
        }
      }
    }
    console.log(`\nSent ${sent}.`);
  })();
}

main();
