import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminBotMockService } from "../extensions/adminbot/src/mock-service.ts";

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

await app.listen(8765, "127.0.0.1");
console.log(`Local AdminBot development service: http://127.0.0.1:8765`);
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
