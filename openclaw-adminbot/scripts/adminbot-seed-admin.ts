// Seeds the first AdminBot admin account so a fresh local ledger has someone who can sign in to
// the console. Every other account arrives through claim/signup and needs an existing admin to
// approve it, so a brand-new database has no way to bootstrap itself. Local development only:
// on a real host the roster is imported and accounts are approved by a human admin.
import { AdminBotAuthService } from "../extensions/adminbot/src/auth.js";
import type { AdminBotLabMemberInput } from "../extensions/adminbot/src/contracts.js";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/service-sqlite.js";

type Args = {
  databasePath: string;
  email: string;
  password: string;
  name: string;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(arg.slice(2), next);
    i += 1;
  }
  const email = values.get("email");
  const password = values.get("password");
  if (!email || !password) {
    throw new Error(
      "usage: node --import tsx scripts/adminbot-seed-admin.ts --email <email> --password <password> [--name <name>] [--db <path>]",
    );
  }
  return {
    databasePath: values.get("db") ?? process.env.ADMINBOT_DB_PATH ?? "state/adminbot.sqlite",
    email,
    password,
    name: values.get("name") ?? email.split("@")[0] ?? "Admin",
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { service, store, close } = createAdminBotSqliteService({
    databasePath: args.databasePath,
  });

  // No inviteToLabCalendar/sendAccountApprovedEmail: approval fires both as side effects, and a
  // seed run must not mail anyone or touch the real lab calendar.
  const auth = new AdminBotAuthService({
    store,
    createMember: (input) => {
      const result = service.upsertLabMember(input);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload;
    },
  });

  try {
    const signup = auth.signup({
      email: args.email,
      password: args.password,
      profile: { name: args.name },
    });
    if (!signup.ok) {
      throw new Error(`signup failed: ${signup.error.message}`);
    }

    const pending = auth
      .listRegistrations("pending")
      .find((entry) => entry.email.toLowerCase() === args.email.toLowerCase());
    if (!pending) {
      throw new Error("signup did not produce a pending registration");
    }

    const approval = auth.approveRegistration(pending.id, "seed-admin-script");
    if (!approval.ok) {
      throw new Error(`approval failed: ${approval.error.message}`);
    }
    const memberId = approval.payload.member_id;

    // Signup always lands as a plain "member" -- privilege_level is governance-owned and never
    // taken from the applicant -- so admin has to be granted as a separate governed edit.
    const elevated = service.upsertLabMember({
      id: memberId,
      name: args.name,
      email: args.email,
      privilege_level: "admin",
    } satisfies AdminBotLabMemberInput);
    if (!elevated.ok) {
      throw new Error(`could not grant admin: ${elevated.error.message}`);
    }

    console.log(`Seeded admin ${args.email} (member ${memberId}) in ${args.databasePath}`);
  } finally {
    close();
  }
}

main();
