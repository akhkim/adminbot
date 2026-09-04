#!/usr/bin/env node --import tsx
/**
 * Run the access audit over the whole contact list and print what onboarding actually did.
 *
 * The question this answers is not "what is each person entitled to" -- `collaborator-subgroups.ts`
 * already states that -- but "did the lab carry it out". For every contact, for every access item
 * their member type entitles them to, it looks for evidence in the three places evidence exists:
 *
 *   the contact fixture   who they are, what the sheet calls them, and which Slack channels they
 *                         are actually in (generated from the workbook by
 *                         scripts/adminbot-contact-roster-collect.py)
 *   the roster database   whether they can sign in, and what their profile holds
 *   the audit trail       whether each onboarding side effect succeeded, failed, or never ran
 *
 * The grading itself lives in extensions/adminbot/src/workflows/members/access-audit.ts, which is
 * pure and unit-tested. This file is only the joining and the printing -- so the rules can be
 * argued with in a test rather than in a script that needs a database to run.
 *
 *   node --import tsx scripts/adminbot-access-audit.ts --db ~/adminbot-aurora.sqlite
 *   node --import tsx scripts/adminbot-access-audit.ts --db ~/adminbot-aurora.sqlite --json out.json
 *   node --import tsx scripts/adminbot-access-audit.ts --db ~/adminbot-aurora.sqlite --member "Ada"
 *
 * Exit code is 1 when any contact has a failing row, so this can gate a release the same way a
 * test does. `--allow-failures` reports without failing, for the common case of reading it.
 */
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AdminBotLabMember } from "../extensions/adminbot/src/contracts/actions.js";
import { normalizePersonName } from "../extensions/adminbot/src/contracts/person-names.js";
import {
  type AccessAuditAttempt,
  type AccessAuditEvidence,
  type AccessAuditRow,
  auditMemberAccess,
  summarizeAccessAudit,
} from "../extensions/adminbot/src/workflows/members/access-audit.js";
import { CONTACT_MEMBERS } from "../extensions/adminbot/src/workflows/members/generated/contact-roster.js";

type Options = {
  db?: string;
  json?: string;
  member?: string;
  allowFailures: boolean;
  showPasses: boolean;
};

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { allowFailures: false, showPasses: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} needs a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--db") {
      options.db = next();
    } else if (arg === "--json") {
      options.json = next();
    } else if (arg === "--member") {
      options.member = next();
    } else if (arg === "--allow-failures") {
      options.allowFailures = true;
    } else if (arg === "--show-passes") {
      options.showPasses = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

const HELP = `adminbot-access-audit -- did onboarding actually grant what the matrix promises?

  --db <path>         roster sqlite snapshot. Without it every database-backed row reports
                      "unverifiable" rather than failing, and the audit is Slack-only.
  --json <path>       write the full per-member findings as JSON.
  --member <name>     audit one person (substring match on the name).
  --show-passes       print passing rows too; by default only failures are listed.
  --allow-failures    exit 0 even when contacts have failing rows.
`;

/**
 * The roster row and onboarding evidence for everyone, keyed by normalized name.
 *
 * Read in three passes rather than per member: the audit touches every contact, and a query per
 * person turns a 155-name run into hundreds of round trips over a 230MB database.
 */
function loadDatabase(path: string): {
  members: Map<string, AdminBotLabMember>;
  credentials: Set<string>;
  attempts: Map<string, MemberAttempts>;
} {
  const db = new DatabaseSync(path, { readOnly: true });
  const members = new Map<string, AdminBotLabMember>();
  const byId = new Map<string, AdminBotLabMember>();
  for (const row of db.prepare("SELECT payload_json FROM adminbot_lab_members").all()) {
    const member = JSON.parse(
      String((row as { payload_json: string }).payload_json),
    ) as AdminBotLabMember;
    members.set(normalizePersonName(member.name), member);
    byId.set(member.id, member);
  }
  const credentials = new Set<string>();
  for (const row of db.prepare("SELECT member_id FROM adminbot_member_credentials").all()) {
    credentials.add(String((row as { member_id: string }).member_id));
  }
  const attempts = new Map<string, MemberAttempts>();
  // Newest last, so a later success overwrites an earlier failure: somebody whose calendar invite
  // failed and was then retried successfully is not still a failure.
  const events = db
    .prepare(
      `SELECT event_type, actor, event_json FROM adminbot_audit_events
         WHERE event_type IN (${AUDITED_EFFECTS.map(() => "?").join(",")})
         ORDER BY timestamp ASC`,
    )
    .all(...AUDITED_EFFECTS);
  for (const raw of events) {
    const row = raw as { event_type: string; actor: string | null; event_json: string };
    const subject = subjectOf(row.actor, row.event_json, byId);
    if (!subject) {
      continue;
    }
    const bucket = attempts.get(subject) ?? emptyAttempts();
    const effect = EFFECT_BY_EVENT[row.event_type];
    if (effect) {
      bucket[effect.field] = effect.outcome;
      attempts.set(subject, bucket);
    }
  }
  db.close();
  return { members, credentials, attempts };
}

type MemberAttempts = {
  calendar_invite: AccessAuditAttempt;
  dcs_form: AccessAuditAttempt;
  approval_email: AccessAuditAttempt;
  onboarding_guide: AccessAuditAttempt;
};

function emptyAttempts(): MemberAttempts {
  return {
    calendar_invite: "no_record",
    dcs_form: "no_record",
    approval_email: "no_record",
    onboarding_guide: "no_record",
  };
}

const EFFECT_BY_EVENT: Record<
  string,
  { field: keyof MemberAttempts; outcome: AccessAuditAttempt }
> = {
  "auth.calendar_invite_sent": { field: "calendar_invite", outcome: "succeeded" },
  "auth.calendar_invite_failed": { field: "calendar_invite", outcome: "failed" },
  "auth.dcs_form_submitted": { field: "dcs_form", outcome: "succeeded" },
  "auth.dcs_form_failed": { field: "dcs_form", outcome: "failed" },
  "auth.approval_email_sent": { field: "approval_email", outcome: "succeeded" },
  "auth.approval_email_failed": { field: "approval_email", outcome: "failed" },
  "onboarding.guide_sent": { field: "onboarding_guide", outcome: "succeeded" },
};

const AUDITED_EFFECTS = Object.keys(EFFECT_BY_EVENT);

/**
 * Which member an onboarding-effect event is *about*.
 *
 * Not simply the actor. These events are recorded by whoever ran the approval -- an admin, or the
 * approval flow itself -- so the actor is often the person who pressed the button rather than the
 * person the invite was for. The subject is in `details` when it is anywhere, under one of a few
 * names, and the actor is the fallback only when it resolves to a real roster row.
 */
function subjectOf(
  actor: string | null,
  eventJson: string,
  byId: ReadonlyMap<string, AdminBotLabMember>,
): string | undefined {
  // A row whose JSON will not parse is a row this cannot attribute; an empty bag makes every
  // lookup below miss and the caller falls through to the actor, which is the right answer.
  const details = ((): Record<string, unknown> => {
    try {
      return (JSON.parse(eventJson) as { details?: Record<string, unknown> }).details ?? {};
    } catch {
      return {};
    }
  })();
  for (const key of ["member_id", "memberId", "member"]) {
    const value = details[key];
    if (typeof value === "string" && byId.has(value)) {
      return normalizePersonName(byId.get(value)!.name);
    }
  }
  for (const key of ["email", "member_email"]) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) {
      const match = [...byId.values()].find((member) =>
        [member.email, member.correspondence_email, member.calendar_email]
          .filter(Boolean)
          .some((address) => address?.toLowerCase() === value.trim().toLowerCase()),
      );
      if (match) {
        return normalizePersonName(match.name);
      }
    }
  }
  return actor && byId.has(actor) ? normalizePersonName(byId.get(actor)!.name) : undefined;
}

/** A contact with no roster row still gets audited -- as somebody onboarding never reached. */
function memberFor(
  contact: (typeof CONTACT_MEMBERS)[number],
  rosterMember: AdminBotLabMember | undefined,
): AdminBotLabMember {
  if (rosterMember) {
    // The sheet's member_type wins: it is the column the lab actually maintains, and the roster
    // copy of it is often blank (93 of 199 rows) because it was imported before the column existed.
    return {
      ...rosterMember,
      ...(contact.fields.member_type ? { member_type: contact.fields.member_type } : {}),
    };
  }
  return {
    id: contact.key,
    name: contact.name,
    privilege_level: "external_collaborator",
    access: [],
    created_at: "",
    updated_at: "",
    ...(contact.fields.correspondence_email ? { email: contact.fields.correspondence_email } : {}),
    ...(contact.fields.member_type ? { member_type: contact.fields.member_type } : {}),
    ...(contact.fields.location ? { location: contact.fields.location } : {}),
    ...(contact.fields.joined_month ? { joined_month: contact.fields.joined_month } : {}),
  } as AdminBotLabMember;
}

function channelsOf(contact: (typeof CONTACT_MEMBERS)[number]): string[] {
  return (contact.fields.channels ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const database = options.db ? loadDatabase(options.db) : undefined;
  if (!database) {
    process.stderr.write(
      "no --db given: every roster- and audit-trail-backed row will report as unverifiable\n\n",
    );
  }

  const contacts = options.member
    ? CONTACT_MEMBERS.filter((contact) =>
        contact.name.toLowerCase().includes(options.member!.toLowerCase()),
      )
    : CONTACT_MEMBERS;

  const rows: AccessAuditRow[] = [];
  let withoutRosterRow = 0;
  for (const contact of contacts) {
    const rosterMember = database?.members.get(contact.key);
    if (!rosterMember) {
      withoutRosterRow += 1;
    }
    const member = memberFor(contact, rosterMember);
    const attempts = database?.attempts.get(contact.key) ?? emptyAttempts();
    const evidence: AccessAuditEvidence = {
      slack_channels: channelsOf(contact),
      // The fixture is always loaded, so Slack rows are always answerable -- an absent Channels
      // cell means "in no channels", which the export does record.
      slack_export_available: true,
      slack_account_known: Boolean(contact.fields.slack_id),
      portal_credential: Boolean(rosterMember && database?.credentials.has(rosterMember.id)),
      audit_trail_available: Boolean(database),
      ...attempts,
    };
    rows.push(auditMemberAccess(member, evidence));
  }

  report(rows, {
    withoutRosterRow,
    showPasses: options.showPasses,
    hasDatabase: Boolean(database),
  });
  if (options.json) {
    writeFileSync(options.json, `${JSON.stringify(rows, null, 2)}\n`);
    process.stdout.write(`\nfull findings -> ${options.json}\n`);
  }
  const summary = summarizeAccessAudit(rows);
  process.exit(!options.allowFailures && summary.fail > 0 ? 1 : 0);
}

function report(
  rows: readonly AccessAuditRow[],
  context: { withoutRosterRow: number; showPasses: boolean; hasDatabase: boolean },
): void {
  const summary = summarizeAccessAudit(rows);
  const out = process.stdout;
  out.write("ACCESS AUDIT -- did onboarding do what the matrix promises?\n");
  out.write(`${"=".repeat(72)}\n\n`);

  // Failures by item first. A reader chasing this list wants "the calendar invite is broken for
  // 40 people", not forty separate rows saying the same thing.
  const byItem = new Map<string, { label: string; members: string[] }>();
  for (const row of rows) {
    for (const finding of row.findings) {
      if (finding.verdict !== "fail") {
        continue;
      }
      const bucket = byItem.get(finding.item) ?? { label: finding.label, members: [] };
      bucket.members.push(row.member_name);
      byItem.set(finding.item, bucket);
    }
  }
  // The split that decides who fixes what. A side effect that was attempted and failed is a
  // broken connector, and one line of the report can stand for all of them; one that never ran is
  // a person who never went through onboarding, and each is their own piece of work. Collapsing
  // the two into "failed" would send somebody to debug a connector for 140 people it was never
  // asked to serve.
  out.write("ONBOARDING SIDE EFFECTS\n");
  const EFFECT_ROWS = [
    ["baseline_approval_email", "account-approved email"],
    ["baseline_calendar_invite", "lab calendar reader invite"],
    ["baseline_dcs_form", "DCS Slack-access form"],
    ["baseline_portal_login", "portal sign-in credential"],
  ] as const;
  for (const [item, label] of EFFECT_ROWS) {
    let ok = 0;
    let broke = 0;
    let never = 0;
    for (const row of rows) {
      const finding = row.findings.find((entry) => entry.item === item);
      if (!finding) {
        continue;
      }
      if (finding.verdict === "pass") {
        ok += 1;
      } else if (finding.detail.includes("FAILED")) {
        broke += 1;
      } else if (finding.verdict === "fail") {
        never += 1;
      }
    }
    out.write(
      `  ${label.padEnd(28)} ok ${String(ok).padStart(4)}` +
        `   attempted+failed ${String(broke).padStart(4)}` +
        `   never ran ${String(never).padStart(4)}\n`,
    );
  }

  out.write("\nFAILURES BY ACCESS ITEM\n");
  if (byItem.size === 0) {
    out.write("  none\n");
  }
  for (const [item, bucket] of [...byItem].toSorted(
    (a, b) => b[1].members.length - a[1].members.length,
  )) {
    out.write(`  ${String(bucket.members.length).padStart(4)}  ${bucket.label}  [${item}]\n`);
  }

  if (context.showPasses || byItem.size > 0) {
    out.write("\nPER-MEMBER FAILURES\n");
    for (const row of rows) {
      const shown = row.findings.filter(
        (finding) =>
          finding.verdict === "fail" || (context.showPasses && finding.verdict === "pass"),
      );
      if (shown.length === 0) {
        continue;
      }
      const type = row.member_type ? ` (${row.member_type})` : "";
      out.write(
        `\n  ${row.member_name}${type} -- graded as ${row.subgroup ?? row.subgroup_source}\n`,
      );
      for (const finding of shown) {
        out.write(
          `      ${finding.verdict === "fail" ? "FAIL" : "pass"}  ${finding.label}: ${finding.detail}\n`,
        );
      }
    }
  }

  out.write(`\n${"=".repeat(72)}\nSUMMARY\n`);
  out.write(`  contacts audited        ${summary.members}\n`);
  out.write(`  with at least one FAIL  ${summary.members_with_failures}\n`);
  out.write(`  rows passed             ${summary.pass}\n`);
  out.write(`  rows failed             ${summary.fail}\n`);
  out.write(`  rows unverifiable       ${summary.unverifiable}   (no evidence source exists)\n`);
  out.write(`  rows not applicable     ${summary.not_applicable}\n`);
  if (context.withoutRosterRow > 0) {
    out.write(`  contacts with no roster row  ${context.withoutRosterRow}\n`);
  }
  if (!context.hasDatabase) {
    out.write("\n  NOTE: run with --db to grade the roster- and audit-trail-backed rows.\n");
  }
}

main();
