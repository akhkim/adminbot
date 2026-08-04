#!/usr/bin/env node
// Creates (or resets) a non-privileged AdminBot test member so the member-side Control UI can
// be exercised without borrowing a real person's login.
//
// The normal way in is self-claim + admin approval over HTTP. That flow deliberately cannot be
// driven by the service principal (registration approval requires a real admin member session),
// so this script seeds the roster row and the credential row directly against the SQLite store.
// Password hashing mirrors hashPassword() in extensions/adminbot/src/auth.ts exactly — same
// scrypt parameters and same `scrypt$N$r$p$salt$hash` base64url serialization — so the service
// verifies it like any self-claimed password.
//
// Usage:
//   node scripts/create-test-member.mjs [--db <path>] [--id <id>] [--email <email>]
//                                       [--name <name>] [--password <pw>]
//                                       [--privilege <level>]
// Prints the generated password when one is not supplied.

import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function hashPassword(password) {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

// Readable but not guessable: a temporary credential meant to be rotated or deleted.
function generatePassword() {
  return `test-${randomBytes(9).toString("base64url")}`;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(import.meta.dirname, "..");
const dbPath = args.db ?? path.join(repoRoot, "state/adminbot.sqlite");
const id = args.id ?? "test-member";
const email = args.email ?? "test.member@test.com";
const name = args.name ?? "Test Member";
const privilege = args.privilege ?? "member";
const generated = !args.password;
const password = args.password ?? generatePassword();

if (privilege === "admin" || privilege === "core_member") {
  console.error(
    `refusing to create a privileged test account (--privilege ${privilege}); this script exists to test the member-side UI`,
  );
  process.exit(1);
}

const now = new Date().toISOString();
const db = new DatabaseSync(dbPath);

const existing = db.prepare("SELECT payload_json FROM adminbot_lab_members WHERE id = ?").get(id);

// Preserve any existing profile so re-running only rotates the password.
const payload = existing
  ? { ...JSON.parse(existing.payload_json), privilege_level: privilege, updated_at: now }
  : {
      id,
      name,
      email,
      privilege_level: privilege,
      status: "active",
      notes: "Temporary testing account for the member-side UI. Not a real lab member.",
      access: [],
      created_at: now,
      updated_at: now,
    };

db.prepare(
  `INSERT INTO adminbot_lab_members (id, privilege_level, updated_at, payload_json)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     privilege_level = excluded.privilege_level,
     updated_at = excluded.updated_at,
     payload_json = excluded.payload_json`,
).run(id, privilege, now, JSON.stringify(payload));

db.prepare(
  `INSERT INTO adminbot_member_credentials (member_id, email, password_scrypt, claimed_at, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(member_id) DO UPDATE SET
     email = excluded.email,
     password_scrypt = excluded.password_scrypt,
     updated_at = excluded.updated_at`,
).run(id, email, hashPassword(password), now, now);

// Any half-finished self-claim would otherwise sit in the admin "Member requests" queue.
db.prepare("DELETE FROM adminbot_account_registrations WHERE member_id = ?").run(id);

db.close();

console.log(`database:  ${dbPath}`);
console.log(`member id: ${id}`);
console.log(`privilege: ${privilege}`);
console.log(`email:     ${email}`);
console.log(`password:  ${password}${generated ? "  (generated — store it or rotate it)" : ""}`);
console.log("\nRestart the AdminBot service if it caches the roster in memory.");
