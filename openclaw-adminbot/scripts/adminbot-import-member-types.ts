// Imports the lab spreadsheet's "Member Type" column (column S) onto the roster, and derives the
// privilege level and collaborator subgroup that go with it.
//
//   node --import tsx scripts/adminbot-import-member-types.ts <file.csv> [--apply] [--base-url URL]
//
// Dry run unless --apply is passed: it prints every change it would make and writes nothing.
//
// Three differences from adminbot-import-member-sheet.ts, which reads the same export:
//
//   1. That one fills blanks and never overwrites. This one *does* overwrite, because it carries a
//      governance decision rather than contact details: the spreadsheet is where the lab records
//      what someone is, so a roster value that disagrees is stale rather than authoritative.
//   2. It touches exactly three fields -- member_type, privilege_level, collaborator_subgroup --
//      and nothing else on the record.
//   3. It never creates anyone. A sheet row matching no roster member is reported and skipped, the
//      same as the sibling: admission goes through registration approval.
//
// `member_type` is stored verbatim, which is what the field is documented to hold. The privilege
// level and subgroup are *derived* from it, by the rules in `classify` below.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AdminBotExternalCollaboratorSubgroup,
  AdminBotPrivilegeLevel,
} from "../extensions/adminbot/src/contracts/actions.js";
import { normalizeName, parseCsv } from "./adminbot-import-member-sheet.ts";

const MEMBER_TYPE_COLUMN = "Member Type";

// Column S token -> the subgroup it names. The sheet writes them in prose-with-hyphens; the
// contract uses snake_case. Tokens absent here are not subgroups: "full" and "adminbot-admin" say
// what privilege someone holds, and "mailing-list" is not part of the access design at all.
export const SUBGROUP_BY_TOKEN: Record<string, AdminBotExternalCollaboratorSubgroup> = {
  interviewee: "interviewee",
  "slightly-better-than-emails": "slightly_better_than_emails",
  acquaintance: "acquaintance",
  alumni: "alumni",
  "own-pace-advisee": "own_pace_advisee",
  "coauthor-minor": "coauthor_minor",
  "coauthor-major": "coauthor_major",
  "coauthor-discussant-or-designer": "coauthor_discussant_designer",
  "disappearing-coauthor": "disappearing_coauthor",
  "external-prof": "external_prof",
};

// Where a row names more than one subgroup, the earliest entry here wins. `alumni` leads
// deliberately: the roster already reads that token as decisive elsewhere (adminBotIsAlumniType --
// "checked after the batch, and it wins"), and of the readings available it is the one that grants
// least. A row like "alumni, coauthor-major" therefore lands on `alumni`, and the summary lists
// every row this rule had to decide so the choice can be overridden per person.
const SUBGROUP_PRECEDENCE: readonly AdminBotExternalCollaboratorSubgroup[] = [
  "alumni",
  "disappearing_coauthor",
  "interviewee",
  "slightly_better_than_emails",
  "acquaintance",
  "external_prof",
  "own_pace_advisee",
  "coauthor_minor",
  "coauthor_major",
  "coauthor_discussant_designer",
];

export function memberTypeTokens(memberType: string): string[] {
  return memberType
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export type Classification =
  | { kind: "full"; privilege_level: AdminBotPrivilegeLevel }
  | {
      kind: "collaborator";
      privilege_level: "external_collaborator";
      collaborator_subgroup: AdminBotExternalCollaboratorSubgroup;
      /** Subgroups the row named that precedence discarded; empty when the row named just one. */
      alsoNamed: AdminBotExternalCollaboratorSubgroup[];
    }
  | { kind: "unmappable"; reason: string };

/**
 * What column S says this person is.
 *
 * "full" wins outright over any subgroup beside it: a full member is not an external collaborator,
 * and the service rejects a subgroup on any privilege level but `external_collaborator`. Rows like
 * "full, coauthor-minor" therefore keep the whole string in `member_type` -- which is what records
 * that they also coauthor -- while the privilege they get is the full member's.
 */
export function classify(memberType: string): Classification {
  const tokens = memberTypeTokens(memberType);
  if (tokens.length === 0) {
    return { kind: "unmappable", reason: "no Member Type in the sheet" };
  }
  if (tokens.includes("full")) {
    return {
      kind: "full",
      privilege_level: tokens.includes("adminbot-admin") ? "admin" : "member",
    };
  }
  const named = tokens.map((token) => SUBGROUP_BY_TOKEN[token]).filter(Boolean);
  const unique = [...new Set(named)] as AdminBotExternalCollaboratorSubgroup[];
  if (unique.length === 0) {
    return { kind: "unmappable", reason: `no subgroup in "${memberType}"` };
  }
  const chosen = SUBGROUP_PRECEDENCE.find((subgroup) => unique.includes(subgroup));
  if (!chosen) {
    return { kind: "unmappable", reason: `no subgroup in "${memberType}"` };
  }
  return {
    kind: "collaborator",
    privilege_level: "external_collaborator",
    collaborator_subgroup: chosen,
    alsoNamed: unique.filter((subgroup) => subgroup !== chosen),
  };
}

type Plan = {
  id: string;
  name: string;
  patch: Record<string, unknown>;
  before: string;
  after: string;
};

async function run(params: {
  rows: Array<Record<string, string>>;
  nameColumn: string;
  apply: boolean;
  baseUrl: string;
}): Promise<void> {
  const token = process.env.ADMINBOT_SERVICE_TOKEN;
  if (!token) {
    throw new Error("ADMINBOT_SERVICE_TOKEN is not set");
  }
  const response = await fetch(`${params.baseUrl}/lab/members`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`could not read the roster: ${response.status}`);
  }
  const roster =
    ((await response.json()) as { members?: Array<Record<string, unknown>> }).members ?? [];
  const byName = new Map(roster.map((m) => [normalizeName(String(m.name ?? "")), m]));

  const plans: Plan[] = [];
  const unchanged: string[] = [];
  const unmatched: string[] = [];
  const unmappable: string[] = [];
  const decided: string[] = [];
  const demotions: string[] = [];

  for (const row of params.rows) {
    const name = (row[params.nameColumn] ?? "").trim();
    if (!name) {
      continue;
    }
    const member = byName.get(normalizeName(name));
    if (!member) {
      unmatched.push(name);
      continue;
    }
    const memberType = (row[MEMBER_TYPE_COLUMN] ?? "").trim();
    const verdict = classify(memberType);
    if (verdict.kind === "unmappable") {
      unmappable.push(`${name} · ${verdict.reason}`);
      continue;
    }

    const patch: Record<string, unknown> = {
      member_type: memberType,
      privilege_level: verdict.privilege_level,
    };
    // Only ever sent for a collaborator. The service validates the field whenever it is present at
    // all, so "" would be rejected as "not one of the subgroups" rather than read as a clear --
    // and it does not need one: upsert drops a stored subgroup by itself the moment the effective
    // privilege level is anything but external_collaborator.
    if (verdict.kind === "collaborator") {
      patch.collaborator_subgroup = verdict.collaborator_subgroup;
    }

    if (verdict.kind === "collaborator" && verdict.alsoNamed.length > 0) {
      decided.push(
        `${name} · sheet says "${memberType}" -> ${verdict.collaborator_subgroup} (not ${verdict.alsoNamed.join(", ")})`,
      );
    }

    const currentPrivilege = String(member.privilege_level ?? "");
    const currentSubgroup = String(member.collaborator_subgroup ?? "");
    const currentType = String(member.member_type ?? "");
    const before = `${currentType || "-"} | ${currentPrivilege || "-"}${currentSubgroup ? `/${currentSubgroup}` : ""}`;
    const after = `${memberType} | ${verdict.privilege_level}${
      verdict.kind === "collaborator" ? `/${verdict.collaborator_subgroup}` : ""
    }`;
    if (before === after) {
      unchanged.push(name);
      continue;
    }
    // Worth calling out separately: this is the one direction that takes access away, and it is
    // the reason this script has a dry run rather than just running.
    if (
      (currentPrivilege === "admin" || currentPrivilege === "member") &&
      verdict.privilege_level === "external_collaborator"
    ) {
      demotions.push(
        `${name} · ${currentPrivilege} -> external_collaborator/${
          verdict.kind === "collaborator" ? verdict.collaborator_subgroup : "?"
        }`,
      );
    }
    plans.push({ id: String(member.id), name, patch, before, after });
  }

  console.log(`sheet rows        : ${params.rows.length}`);
  console.log(`matched by name   : ${plans.length + unchanged.length + unmappable.length}`);
  console.log(`already correct   : ${unchanged.length}`);
  console.log(`would change      : ${plans.length}`);
  console.log(`no Member Type    : ${unmappable.length} (left exactly as they are)`);
  console.log(`not on the roster : ${unmatched.length} (skipped, never created)`);

  if (plans.length) {
    console.log(`\nchanges (before -> after):`);
    for (const plan of plans) {
      console.log(`  ${plan.name}`);
      console.log(`      ${plan.before}`);
      console.log(`   -> ${plan.after}`);
    }
  }
  if (demotions.length) {
    console.log(`\n${demotions.length} would LOSE full-member privilege — check these first:`);
    for (const line of demotions) {
      console.log(`  ${line}`);
    }
  }
  if (decided.length) {
    console.log(`\n${decided.length} row(s) named more than one subgroup; precedence chose:`);
    for (const line of decided) {
      console.log(`  ${line}`);
    }
  }
  if (unmappable.length) {
    console.log(`\n${unmappable.length} row(s) with nothing to import — untouched:`);
    for (const line of unmappable) {
      console.log(`  ${line}`);
    }
  }
  if (unmatched.length) {
    console.log(`\nno roster member for ${unmatched.length} row(s) — skipped, never created:`);
    for (const name of unmatched) {
      console.log(`  ${name}`);
    }
  }

  if (!params.apply) {
    console.log(
      `\nDRY RUN — nothing written. Re-run with --apply to write ${plans.length} members.`,
    );
    return;
  }

  let written = 0;
  for (const plan of plans) {
    const result = await fetch(`${params.baseUrl}/lab/members/${encodeURIComponent(plan.id)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(plan.patch),
    });
    if (!result.ok) {
      console.error(`  failed ${plan.name}: ${result.status} ${await result.text()}`);
      continue;
    }
    written += 1;
  }
  console.log(`\napplied to ${written}/${plans.length} members`);
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--"));
  const apply = args.includes("--apply");
  const baseUrl =
    args.includes("--base-url") && args[args.indexOf("--base-url") + 1]?.startsWith("http")
      ? (args[args.indexOf("--base-url") + 1] as string)
      : "http://127.0.0.1:8765";
  if (!file) {
    throw new Error("usage: adminbot-import-member-types.ts <file.csv> [--apply] [--base-url URL]");
  }

  const table = parseCsv(fs.readFileSync(file, "utf8"));
  const header = (table[0] ?? []).map((cell) => cell.trim().replace(/^﻿/u, ""));
  if (!header.includes(MEMBER_TYPE_COLUMN)) {
    throw new Error(`the sheet has no "${MEMBER_TYPE_COLUMN}" column: ${header.join(" | ")}`);
  }
  const rows = table
    .slice(1)
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""])));

  void run({ rows, nameColumn: header[0] ?? "", apply, baseUrl });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
