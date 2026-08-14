/**
 * Local AdminBot service against a throwaway database, with one seeded admin account.
 *
 * Brought across from the lab branch `luke/time-allocation` (commit a4c560bd), where it was added
 * alongside the time-availability tab so that surface could be driven without the real service.
 * The mock service moved to `extensions/adminbot/src/api/server.ts` in the restructuring; that
 * import is the only change from the original.
 *
 * Distinct from `start-adminbot.mjs`, which runs the real service against the real database. This
 * one deliberately stubs the calendar and email connectors, so nothing it does leaves the machine.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminBotMockService } from "../extensions/adminbot/src/api/server.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const email = requireEnv("ADMINBOT_DEV_EMAIL").toLowerCase();
const password = requireEnv("ADMINBOT_DEV_PASSWORD");
const name = process.env.ADMINBOT_DEV_NAME?.trim() || "Local Dev Admin";
const databasePath = path.resolve(
  repoRoot,
  process.env.ADMINBOT_DEV_DATABASE?.trim() || "state/adminbot-dev.sqlite",
);

if (password.length < 10) {
  throw new Error("ADMINBOT_DEV_PASSWORD must be at least 10 characters");
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const app = createAdminBotMockService({
  databasePath,
  auditRetentionDays: 7,
  // Keep this local bootstrap isolated from real calendar/email connectors.
  calendarInviteRunner: async () => {},
  accountApprovedEmailRunner: async () => {},
});

let login = app.auth.login({ email, password });
if (!login.ok) {
  const signup = app.auth.signup({
    email,
    password,
    profile: { name, role: "Lab Manager" },
  });
  if (!signup.ok) {
    throw new Error(
      `Could not create the local account: ${signup.error.message}. ` +
        "If this email already exists, use its original password or choose a fresh ADMINBOT_DEV_DATABASE.",
    );
  }

  const registration = app.auth
    .listRegistrations("pending")
    .find((candidate) => candidate.email === email);
  if (!registration) {
    throw new Error("Local account registration was not persisted");
  }

  const approval = app.auth.approveRegistration(registration.id, "local-dev-bootstrap");
  if (!approval.ok) {
    throw new Error(`Could not approve the local account: ${approval.error.message}`);
  }

  login = app.auth.login({ email, password });
}

if (!login.ok) {
  throw new Error(
    `Could not sign in to the local account: ${login.error.message}. ` +
      "Use its original password or choose a fresh ADMINBOT_DEV_DATABASE.",
  );
}

const {
  access: _access,
  onboarding: _onboarding,
  created_at: _createdAt,
  updated_at: _updatedAt,
  ...member
} = login.payload.member;
const elevated = app.service.upsertLabMember({
  ...member,
  privilege_level: "admin",
});
if (!elevated.ok) {
  throw new Error(`Could not grant local admin access: ${elevated.error.message}`);
}

// The systemd unit usually holds 8765, and a dev bootstrap that cannot start because the real
// service is running is a confusing way to find that out. Same override the real launcher takes.
const port = Number(process.env.ADMINBOT_PORT?.trim() || 8765);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(
    `ADMINBOT_PORT must be an integer between 0 and 65535, got ${process.env.ADMINBOT_PORT}`,
  );
}

await app.listen(port, "127.0.0.1");
console.log(`Local AdminBot development service: http://127.0.0.1:${port}`);
console.log(`Local admin email: ${email}`);
console.log("Use the ADMINBOT_DEV_PASSWORD value from this terminal to sign in.");
console.log(`Local-only database: ${databasePath}`);

function requireEnv(variableName: string): string {
  const value = process.env[variableName]?.trim();
  if (!value) {
    throw new Error(`${variableName} is required`);
  }
  return value;
}
