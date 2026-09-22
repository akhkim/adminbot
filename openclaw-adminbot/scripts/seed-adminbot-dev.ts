/**
 * Seeds fictional members and usable accounts through the service and auth APIs.
 * No connectors are installed: approving a fixture account must never send mail or invites.
 * Stable dev-* IDs make repeats update profiles without duplicating accounts or resetting passwords.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminBotPrivilegeLevels,
  type AdminBotLabMemberInput,
} from "../extensions/adminbot/src/contracts/actions.js";
import { AdminBotService } from "../extensions/adminbot/src/kernel/service.js";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/persistence/sqlite.js";
import { AdminBotAuthService } from "../extensions/adminbot/src/workflows/identity/auth.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultFixture = path.join(repoRoot, "dev/fixtures/members.json");
const stringFields = new Set([
  "id",
  "name",
  "email",
  "privilege_level",
  "role",
  "status",
  "location",
  "timezone",
  "affiliation",
  "research_branch",
  "notes",
]);
const listFields = new Set(["research_topics", "projects"]);

type DevMember = AdminBotLabMemberInput & { email: string };

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

export function parseDevMembers(value: unknown): DevMember[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("The fixture must be a nonempty array of fictional members");
  }
  const ids = new Set<string>();
  const emails = new Set<string>();
  const validator = new AdminBotService();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each fixture member must be an object");
    }
    for (const [key, field] of Object.entries(entry)) {
      if (stringFields.has(key) && typeof field === "string") {
        continue;
      }
      if (
        listFields.has(key) &&
        Array.isArray(field) &&
        field.every((item) => typeof item === "string")
      ) {
        continue;
      }
      if (key === "hours_per_week" && typeof field === "number" && Number.isFinite(field)) {
        continue;
      }
      throw new Error(`Unsupported fixture field or value: ${key}`);
    }
    const member = entry as DevMember;
    if (typeof member.id !== "string" || !/^dev-[a-z0-9-]+$/u.test(member.id)) {
      throw new Error(
        "Fixture member IDs must start with dev- and use lowercase letters, digits or hyphens",
      );
    }
    if (
      typeof member.email !== "string" ||
      !/^[a-z0-9._+-]+@example\.(test|com|org|net)$/u.test(member.email)
    ) {
      throw new Error(
        "Fixture emails must be lowercase addresses at example.test, example.com, example.org or example.net",
      );
    }
    if (ids.has(member.id) || emails.has(member.email)) {
      throw new Error("Fixture IDs and emails must be unique");
    }
    if (
      member.privilege_level !== undefined &&
      !adminBotPrivilegeLevels.includes(member.privilege_level)
    ) {
      throw new Error("Invalid fixture privilege_level");
    }
    ids.add(member.id);
    emails.add(member.email);
    // Validate every row before opening the destination, including the service's profile rules.
    unwrap(validator.upsertLabMember(member));
    return member;
  });
}

export function seedAdminBotDev(options: {
  password: string;
  databasePath?: string;
  fixturePath?: string;
}): { databasePath: string; members: number; accountsCreated: number } {
  if (!options.password || options.password.length < 10) {
    throw new Error("ADMINBOT_DEV_PASSWORD must be at least 10 characters");
  }
  const databasePath = path.resolve(repoRoot, options.databasePath ?? "state/adminbot-dev.sqlite");
  // A distinct filename makes accidentally targeting the normal ledger harder. Resolve existing
  // symlinks too, so a dev-named link cannot silently point at state/adminbot.sqlite.
  const resolvedPath = fs.existsSync(databasePath) ? fs.realpathSync(databasePath) : databasePath;
  if (
    !path.basename(databasePath).endsWith("-dev.sqlite") ||
    !path.basename(resolvedPath).endsWith("-dev.sqlite")
  ) {
    throw new Error(
      "Use a development database named *-dev.sqlite; the normal adminbot.sqlite is refused",
    );
  }
  const fixturePath = path.resolve(repoRoot, options.fixturePath ?? defaultFixture);
  const members = parseDevMembers(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
  const { service, store, close } = createAdminBotSqliteService({ databasePath });
  const auth = new AdminBotAuthService({
    store,
    createMember: (input) => unwrap(service.upsertLabMember(input)),
  });
  try {
    // Refuse identity collisions before updating any profile. An email change needs deliberate
    // account management; seeding must not attach an existing person's login to a different ID.
    for (const member of members) {
      const existing = store.getLabMember(member.id);
      const byId = store.getCredentialByMemberId(member.id);
      const byEmail = store.getCredentialByEmail(member.email);
      const otherMember = store
        .listLabMembers()
        .find(
          (candidate) =>
            candidate.id !== member.id && candidate.email?.toLowerCase() === member.email,
        );
      if (
        (existing && existing.email !== member.email) ||
        (byId && byId.email !== member.email) ||
        (byEmail && byEmail.member_id !== member.id) ||
        otherMember ||
        store.getPendingRegistrationByEmail(member.email) ||
        store.getPendingRegistrationByMemberId(member.id)
      ) {
        throw new Error(
          `Account collision for ${member.id}; use a fresh development database or resolve it first`,
        );
      }
    }
    let accountsCreated = 0;
    for (const member of members) {
      unwrap(service.upsertLabMember(member, { source: "import", actor: "dev-fixtures" }));
      if (store.getCredentialByMemberId(member.id)) {
        continue;
      }
      unwrap(auth.claim({ member_id: member.id, email: member.email, password: options.password }));
      const pending = store.getPendingRegistrationByMemberId(member.id);
      if (!pending) {
        throw new Error(`Missing fixture registration for ${member.id}`);
      }
      unwrap(auth.approveRegistration(pending.id, "dev-fixtures"));
      accountsCreated += 1;
    }
    return { databasePath, members: members.length, accountsCreated };
  } finally {
    close();
  }
}

function main(): void {
  if (process.argv.length > 2) {
    throw new Error(
      "Configure this script with ADMINBOT_DEV_PASSWORD, ADMINBOT_DEV_DATABASE and ADMINBOT_DEV_FIXTURE",
    );
  }
  const result = seedAdminBotDev({
    password: process.env.ADMINBOT_DEV_PASSWORD ?? "",
    databasePath: process.env.ADMINBOT_DEV_DATABASE?.trim() || undefined,
    fixturePath: process.env.ADMINBOT_DEV_FIXTURE?.trim() || undefined,
  });
  console.log(`Seeded ${result.members} fictional profiles in ${result.databasePath}`);
  console.log(`Created ${result.accountsCreated} logins; existing passwords were preserved.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
