// Imports the lab spreadsheet's "Member Type" column (column S) onto the roster, and derives the
// privilege level and collaborator subgroup that go with it.
//
//   node --import tsx scripts/adminbot-import-member-types.ts <file.csv> [--apply] [--base-url URL]
//                                                              [--skip NAME]
//
// Dry run unless --apply is passed: it prints every change it would make and writes nothing.
//
// The dry run reads the roster with ADMINBOT_SERVICE_TOKEN. `--apply` additionally needs
// ADMINBOT_ADMIN_SESSION_TOKEN, an admin Control UI session: privilege_level and
// collaborator_subgroup are governance fields, and the service principal is not allowed to set
// them on any record, including through this script.
//
// `--skip NAME` leaves a roster record exactly as it is, matched on the roster's name. It exists
// for the row that would demote whoever is running the import.
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
  // The sheet grades interviews in the same column: "probing" is a conversation still in progress
  // and "reject" is one that ended in a no. Both are the same *access* shape -- somebody the lab
  // has talked to and granted nothing further -- so both land on `interviewee` rather than earning
  // subgroups of their own. Whether a rejected candidate should hold a roster row at all is a
  // separate question, settled by the prune rather than by this map.
  "interviewee-probing": "interviewee",
  "interviewee-reject": "interviewee",
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

// Where a row names more than one subgroup, the earliest entry here wins: the most engaged
// collaboration the row names, not the lightest.
//
// This is a lab decision rather than something the sheet settles. A row reading
// "alumni, coauthor-major" describes someone who has left the day-to-day and is still doing
// 20-40 hrs/week on a paper, and it is the coauthoring that says what access they need now --
// the project channel, the weekly meeting, a place on the sponsor roster. `alumni` is read here
// as where they came from. (Note that this is the opposite reading from adminBotIsAlumniType,
// which asks a different question -- "should a sweep address this person" -- and for that one
// having left still wins.)
//
// Every row this rule has to decide is listed in the run summary, so a person it gets wrong can
// be set by hand rather than by changing the order for everybody.
const SUBGROUP_PRECEDENCE: readonly AdminBotExternalCollaboratorSubgroup[] = [
  "coauthor_discussant_designer",
  "coauthor_major",
  "coauthor_minor",
  "own_pace_advisee",
  "external_prof",
  "acquaintance",
  "slightly_better_than_emails",
  "interviewee",
  "disappearing_coauthor",
  "alumni",
];

/**
 * Column S tokens that grant the admin privilege.
 *
 * `adminbot-admin` is the documented spelling and `admin` is the one the sheet also uses. Reading
 * only the former did not make the other row safe -- it made it silently a plain member, which is
 * the quieter half of getting an access decision wrong.
 */
const ADMIN_TOKENS = new Set(["adminbot-admin", "admin"]);

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
      privilege_level: tokens.some((token) => ADMIN_TOKENS.has(token)) ? "admin" : "member",
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

/**
 * Roster lookup by every address a record carries.
 *
 * The sheet's lower section leaves the name column blank and identifies people by their Slack
 * address instead, so a name-only matcher skips those rows without saying so -- 33 of them on the
 * current export, all but one of them somebody this import is supposed to reach.
 *
 * An address two records share identifies neither, and is stored as `null` so the caller reports
 * the clash rather than picking whichever record happened to be read second.
 */
function rosterByEmail(
  roster: ReadonlyArray<Record<string, unknown>>,
): Map<string, Record<string, unknown> | null> {
  const byEmail = new Map<string, Record<string, unknown> | null>();
  for (const member of roster) {
    for (const field of ["email", "correspondence_email", "calendar_email"]) {
      const address = String(member[field] ?? "")
        .trim()
        .toLowerCase();
      if (!address) {
        continue;
      }
      const seen = byEmail.get(address);
      byEmail.set(address, seen === undefined || seen === member ? member : null);
    }
  }
  return byEmail;
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
  /** Columns to identify a row by when the name column is blank, in the order they are tried. */
  emailColumns: readonly string[];
  /** Roster names to leave exactly as they are, normalized. Set by `--skip`. */
  skip: ReadonlySet<string>;
  apply: boolean;
  baseUrl: string;
}): Promise<void> {
  // Reading the roster takes any principal; writing `privilege_level` and `collaborator_subgroup`
  // takes an admin *member* session, because the service deliberately limits the shared service
  // principal to the same whitelist as a member self-edit (see the PUT /lab/members/:id handler).
  // Checked before the first write rather than discovered on it: the failure is otherwise one 400
  // per member, after the run has already reported what it was about to do.
  const adminToken = process.env.ADMINBOT_ADMIN_SESSION_TOKEN;
  const token = adminToken ?? process.env.ADMINBOT_SERVICE_TOKEN;
  if (!token) {
    throw new Error("neither ADMINBOT_ADMIN_SESSION_TOKEN nor ADMINBOT_SERVICE_TOKEN is set");
  }
  if (params.apply && !adminToken) {
    throw new Error(
      "--apply writes privilege_level, which the service token may not set. " +
        "Set ADMINBOT_ADMIN_SESSION_TOKEN to an admin Control UI session token " +
        "(localStorage key openclaw.adminbot.session.v1, or POST /auth/login -> session_token).",
    );
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
  const byEmail = rosterByEmail(roster);

  const plans: Plan[] = [];
  const unchanged: string[] = [];
  const unmatched: string[] = [];
  const unmappable: string[] = [];
  const decided: string[] = [];
  const demotions: string[] = [];
  const skipped: string[] = [];
  const ambiguous: string[] = [];

  for (const row of params.rows) {
    const name = (row[params.nameColumn] ?? "").trim();
    let member = name ? byName.get(normalizeName(name)) : undefined;
    let label = name;
    if (!member && !name) {
      for (const column of params.emailColumns) {
        const address = (row[column] ?? "").trim().toLowerCase();
        if (!address) {
          continue;
        }
        const found = byEmail.get(address);
        if (found === null) {
          ambiguous.push(`${address} · more than one roster record carries this address`);
          label = address;
          break;
        }
        if (found) {
          member = found;
          label = `${String(found.name ?? address)} (matched on ${address})`;
          break;
        }
        label ||= address;
      }
    }
    // Nothing on the row identifies anybody -- no name and no address. Not worth reporting.
    if (!label) {
      continue;
    }
    if (!member) {
      unmatched.push(label);
      continue;
    }
    if (params.skip.has(normalizeName(String(member.name ?? "")))) {
      skipped.push(`${String(member.name ?? label)} · --skip`);
      continue;
    }
    const memberType = (row[MEMBER_TYPE_COLUMN] ?? "").trim();
    const verdict = classify(memberType);
    if (verdict.kind === "unmappable") {
      unmappable.push(`${label} · ${verdict.reason}`);
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
        `${label} · sheet says "${memberType}" -> ${verdict.collaborator_subgroup} (not ${verdict.alsoNamed.join(", ")})`,
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
        `${label} · ${currentPrivilege} -> external_collaborator/${
          verdict.kind === "collaborator" ? verdict.collaborator_subgroup : "?"
        }`,
      );
    }
    plans.push({ id: String(member.id), name: label, patch, before, after });
  }

  console.log(`sheet rows        : ${params.rows.length}`);
  console.log(
    `matched to roster : ${plans.length + unchanged.length + unmappable.length + skipped.length}`,
  );
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
  if (skipped.length) {
    console.log(`\n${skipped.length} row(s) left untouched by request:`);
    for (const line of skipped) {
      console.log(`  ${line}`);
    }
  }
  if (ambiguous.length) {
    console.log(`\n${ambiguous.length} address(es) that identify more than one record — skipped:`);
    for (const line of ambiguous) {
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
  const flagValues = new Set(
    args.flatMap((arg, index) => (arg === "--skip" || arg === "--base-url" ? [index + 1] : [])),
  );
  const file = args.find((arg, index) => !arg.startsWith("--") && !flagValues.has(index));
  const apply = args.includes("--apply");
  // Roster names this run must not touch. The sheet is the authority on what somebody *is*, but a
  // row that would take away the privilege of the person doing the import is worth being able to
  // hold back by hand rather than by editing the export.
  const skip = new Set(
    args.flatMap((arg, index) =>
      arg === "--skip" && args[index + 1] ? [normalizeName(args[index + 1] as string)] : [],
    ),
  );
  const baseUrl =
    args.includes("--base-url") && args[args.indexOf("--base-url") + 1]?.startsWith("http")
      ? (args[args.indexOf("--base-url") + 1] as string)
      : "http://127.0.0.1:8765";
  if (!file) {
    throw new Error(
      "usage: adminbot-import-member-types.ts <file.csv> [--apply] [--base-url URL] [--skip NAME]",
    );
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

  // Every address column the sheet carries, used only for rows with no name.
  const emailColumns = header.filter((key) => /mail/iu.test(key));
  void run({ rows, nameColumn: header[0] ?? "", emailColumns, skip, apply, baseUrl });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
