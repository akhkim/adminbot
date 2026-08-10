// Fills in the `role` field on roster records that predate the role vocabulary.
//
// `role` is now a closed list (adminBotMemberRoles in contracts/actions.ts), but 158 imported profiles were
// written before it existed and left it empty. The information is not lost — most of them carry a
// "Career stage:" line on their notes, put there by the quick-start survey importer — so this maps
// that line onto the vocabulary rather than asking 100 people to re-enter what they already told us.
//
// Anything the map does not cover is left alone and reported: a wrong role is worse than a missing
// one, and the roster is filtered by role.
import fs from "node:fs";
import path from "node:path";
import {
  adminBotMemberRoles,
  type AdminBotMemberRole,
} from "../extensions/adminbot/src/contracts/actions.js";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/persistence/sqlite.js";

// Career stage as the survey recorded it -> the role it means. Keys are matched lowercased and
// trimmed. A combined stage ("PhD / MSc", "PhD Mentee / MSc") takes the senior half: it describes
// someone who has moved on, and the roster wants where they are now.
const STAGE_TO_ROLE: Record<string, AdminBotMemberRole> = {
  bs: "Undergraduate Student",
  bsc: "Undergraduate Student",
  msc: "Master's Student",
  ms: "Master's Student",
  phd: "PhD Student",
  "phd / msc": "PhD Student",
  "phd / bs": "PhD Student",
  "phd mentee": "PhD Student",
  "phd mentee / msc": "PhD Student",
  postdoc: "Postdoc",
  "gap-year ra": "Research Assistant",
  "part-time ra": "Research Assistant",
  ra: "Research Assistant",
  intern: "Research Intern",
  professor: "Professor",
  // Industry titles: the survey let people write their job title where a stage was asked for.
  "data and applied scientist": "Industry Researcher",
  analyst: "Industry Researcher",
  "member of technical staff": "Industry Researcher",
  "engineer scientist": "Industry Researcher",
};

export function careerStageFromNotes(notes: string | undefined): string {
  const line = (notes ?? "")
    .split("\n")
    .find((entry) => entry.trim().toLowerCase().startsWith("career stage:"));
  return line ? line.slice(line.indexOf(":") + 1).trim() : "";
}

export function roleForCareerStage(stage: string): AdminBotMemberRole | undefined {
  return STAGE_TO_ROLE[stage.trim().toLowerCase()];
}

// An existing role that only differs by case or spacing from the vocabulary ("PhD student") is a
// match, not an unknown: it is the same answer typed before the list existed.
export function normalizeExistingRole(role: string): AdminBotMemberRole | undefined {
  const needle = role.trim().toLowerCase();
  return adminBotMemberRoles.find((entry) => entry.toLowerCase() === needle);
}

type Options = { databasePath: string; apply: boolean };

function parseArgs(args: string[]): Options {
  let databasePath = "state/adminbot.sqlite";
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--database" && args[index + 1]) {
      databasePath = args[index + 1]!;
      index += 1;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { databasePath: path.resolve(databasePath), apply };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.databasePath)) {
    throw new Error(`database not found: ${options.databasePath}`);
  }
  const { service, close } = createAdminBotSqliteService({
    databasePath: options.databasePath,
    auditRetentionDays: 30,
  });
  try {
    const listed = service.listLabMembers();
    if (!listed.ok) {
      throw new Error(listed.error.message);
    }
    const planned: Array<{ id: string; from: string; to: AdminBotMemberRole; via: string }> = [];
    const unresolved: Array<{ id: string; stage: string; role: string }> = [];
    for (const member of listed.payload.members) {
      const existing = (member.role ?? "").trim();
      if (existing) {
        const normalized = normalizeExistingRole(existing);
        if (normalized && normalized !== existing) {
          planned.push({ id: member.id, from: existing, to: normalized, via: "existing role" });
        } else if (!normalized) {
          unresolved.push({ id: member.id, stage: "", role: existing });
        }
        continue;
      }
      const stage = careerStageFromNotes(member.notes);
      const mapped = roleForCareerStage(stage);
      if (mapped) {
        planned.push({ id: member.id, from: "", to: mapped, via: `career stage "${stage}"` });
      } else if (stage) {
        unresolved.push({ id: member.id, stage, role: "" });
      }
    }

    for (const entry of planned) {
      process.stdout.write(
        `${options.apply ? "set" : "would set"} ${entry.id}: ${entry.from || "(empty)"} -> ${entry.to}  [${entry.via}]\n`,
      );
      if (options.apply) {
        const result = service.upsertLabMember({
          id: entry.id,
          name: listed.payload.members.find((member) => member.id === entry.id)?.name ?? entry.id,
          role: entry.to,
        });
        if (!result.ok) {
          throw new Error(`failed to update ${entry.id}: ${result.error.message}`);
        }
      }
    }
    for (const entry of unresolved) {
      process.stdout.write(
        `left alone ${entry.id}: ${entry.role ? `role "${entry.role}"` : `career stage "${entry.stage}"`} has no vocabulary match\n`,
      );
    }
    process.stdout.write(
      `\n${planned.length} ${options.apply ? "updated" : "to update"}, ${unresolved.length} left alone, ${listed.payload.members.length} members total.\n`,
    );
    if (!options.apply) {
      process.stdout.write("Dry run. Re-run with --apply to write.\n");
    }
  } finally {
    close();
  }
}

// Same guard the other adminbot scripts use, so the helpers above stay importable from tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
