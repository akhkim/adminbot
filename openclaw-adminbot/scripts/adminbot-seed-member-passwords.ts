// Gives every credential-less roster member a starting password, so people who never claimed an
// account can be told "log in with this and change it" instead of walking the claim/approve flow.
//
//   node --import tsx scripts/adminbot-seed-member-passwords.ts [db] [--write] [--password <pw>]
//
// Dry run by default: it prints exactly what it would write and touches nothing. `--write` is the
// only thing that commits.
//
// Only members with *no* credential row are considered. An existing credential is never touched --
// not its password, not its email -- because a member who already claimed their account has a
// password only they know, and overwriting it would lock them out silently.
//
// The login email is the record's own @cs.toronto.edu address when it has one (checking every
// address field, since the sheet import scattered them across three), and otherwise whatever
// address is already on file -- for most of the roster that value came from the Slack directory
// import, which is what makes it "their Slack email". A member with no usable address is skipped
// and named in the report: `email` is the login identity, so there is nothing to log in as.
import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "../extensions/adminbot/src/workflows/identity/auth.ts";

const DEFAULT_PASSWORD = "jinesis";
const CS_DOMAIN = "@cs.toronto.edu";

// Deliberately loose: this rejects the junk the roster actually contains (a "Mon, Thu, Fri" in an
// email column, empty strings, stray labels) rather than trying to adjudicate RFC 5322. A wrong
// address here costs one skipped member, which the report names.
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u;

// Every column that can hold a real address for a person, in the order the login identity should
// prefer them when none is a cs.toronto.edu one.
const EMAIL_FIELDS = ["email", "correspondence_email", "calendar_email"] as const;

type MemberRow = { id: string; payload_json: string };

type Plan = {
  memberId: string;
  name: string;
  email: string;
  source: string;
  // Set when this plan shares a name with another and neither carries the lab address, so the
  // report can flag the pair without withholding either login.
  duplicateNote?: string;
};

type Skip = {
  memberId: string;
  name: string;
  reason: string;
};

// Names reduced to something two records for the same person agree on: lowercase, accents folded,
// punctuation dropped, runs of whitespace collapsed.
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Groups plans that look like the same person listed twice.
 *
 * The rule is prefix containment on the normalized name, which is what the two real cases on the
 * roster look like: "Furkan" against "Furkan Danisman" (a record made before the last name was
 * known) and "Chijioke Ugwuany" against "Chijioke Ugwuanyi" (a typo). Deliberately not fuzzy
 * matching -- an edit-distance rule that merges "Yiwen Ding" into "Yiwen Dong" would silently
 * deny a real person their login, which is a worse failure than leaving a duplicate for a human
 * to spot in the report.
 */
function samePerson(left: string, right: string): boolean {
  const a = normalizeName(left).split(" ").filter(Boolean);
  const b = normalizeName(right).split(" ").filter(Boolean);
  if (!a.length || !b.length) {
    return false;
  }
  // One name list is the start of the other: "Furkan" against "Furkan Danisman".
  const short = a.length <= b.length ? a : b;
  const long = short === a ? b : a;
  if (short.every((token, index) => token === long[index])) {
    return true;
  }
  // Same given names, and one surname is the start of the other: "Chijioke Ugwuany" against
  // "Chijioke Ugwuanyi", where a dropped final letter leaves no word boundary to match on.
  if (a.length !== b.length || a.length < 2) {
    return false;
  }
  const head = a.slice(0, -1).every((token, index) => token === b[index]);
  const tailA = a.at(-1)!;
  const tailB = b.at(-1)!;
  return head && (tailA.startsWith(tailB) || tailB.startsWith(tailA));
}

function duplicateGroups(plans: Plan[]): Plan[][] {
  const groups: Plan[][] = [];
  for (const plan of plans) {
    const existing = groups.find((group) =>
      group.some((member) => samePerson(plan.name, member.name)),
    );
    if (existing) {
      existing.push(plan);
    } else {
      groups.push([plan]);
    }
  }
  return groups.filter((group) => group.length > 1);
}

function usableEmails(payload: Record<string, unknown>): Array<{ email: string; source: string }> {
  const found: Array<{ email: string; source: string }> = [];
  for (const field of EMAIL_FIELDS) {
    const raw = payload[field];
    if (typeof raw !== "string") {
      continue;
    }
    const email = raw.trim().toLowerCase();
    if (EMAIL_SHAPE.test(email)) {
      found.push({ email, source: field });
    }
  }
  return found;
}

function planFor(row: MemberRow): Plan | Skip {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : row.id;
  const candidates = usableEmails(payload);
  if (!candidates.length) {
    return { memberId: row.id, name, reason: "no usable email on the record" };
  }
  const cs = candidates.find((candidate) => candidate.email.endsWith(CS_DOMAIN));
  const chosen = cs ?? candidates[0]!;
  return { memberId: row.id, name, email: chosen.email, source: chosen.source };
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const passwordAt = args.indexOf("--password");
  const password = passwordAt >= 0 ? args[passwordAt + 1] : DEFAULT_PASSWORD;
  if (!password) {
    throw new Error("--password needs a value");
  }
  // `passwordAt + 1` is only a value slot when the flag is actually present; with no --password
  // the -1 would otherwise make it 0 and swallow the database path.
  const passwordValueAt = passwordAt >= 0 ? passwordAt + 1 : -1;
  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && index !== passwordValueAt,
  );
  const databasePath =
    positional[0] ?? `${process.env.HOME ?? ""}/.openclaw/state/adminbot.sqlite`;

  const db = new DatabaseSync(databasePath);
  const rows = db
    .prepare(
      `SELECT id, payload_json FROM adminbot_lab_members
       WHERE id NOT IN (SELECT member_id FROM adminbot_member_credentials)
       ORDER BY id`,
    )
    .all() as unknown as MemberRow[];

  // Addresses already spoken for. `email` is UNIQUE on the credential table and login looks a
  // member up by it, so a duplicate would either throw here or make two people share one login.
  const taken = new Set(
    (
      db.prepare("SELECT email FROM adminbot_member_credentials").all() as unknown as Array<{
        email: string;
      }>
    ).map((row) => row.email.toLowerCase()),
  );

  const plans: Plan[] = [];
  const skips: Skip[] = [];
  for (const row of rows) {
    const result = planFor(row);
    if ("reason" in result) {
      skips.push(result);
      continue;
    }
    if (taken.has(result.email)) {
      skips.push({
        memberId: result.memberId,
        name: result.name,
        reason: `email ${result.email} is already a login for another member`,
      });
      continue;
    }
    taken.add(result.email);
    plans.push(result);
  }

  // Someone who already holds a login counts as that person's one account. Without this, a second
  // roster record for them looks unclaimed on a later run -- there is no longer another *plan* to
  // group it against -- and would quietly be handed a login of its own.
  const credentialed = (
    db
      .prepare(
        `SELECT m.id, m.payload_json, c.email FROM adminbot_lab_members m
         JOIN adminbot_member_credentials c ON c.member_id = m.id`,
      )
      .all() as unknown as Array<{ id: string; payload_json: string; email: string }>
  ).map((row) => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    return {
      memberId: row.id,
      name: typeof payload.name === "string" ? payload.name : row.id,
      email: row.email,
      source: "existing",
    };
  });
  for (const plan of [...plans]) {
    const held = credentialed.find((other) => samePerson(plan.name, other.name));
    if (!held) {
      continue;
    }
    plans.splice(plans.indexOf(plan), 1);
    skips.push({
      memberId: plan.memberId,
      name: plan.name,
      reason: `duplicate of ${held.name} [${held.memberId}], which already logs in as ${held.email}`,
    });
  }

  // One login per person. Where the roster lists someone twice, the record with the
  // @cs.toronto.edu address wins and the other is skipped -- seeding both would hand one person
  // two accounts, and the lab address is the one they are reachable at. A group with no
  // cs.toronto.edu record is left alone: choosing between two personal addresses is a guess, and
  // the report names the pair so it can be settled on the roster instead.
  for (const group of duplicateGroups(plans)) {
    const preferred = group.find((plan) => plan.email.endsWith(CS_DOMAIN));
    if (!preferred) {
      for (const plan of group) {
        plan.duplicateNote = `duplicate name, no ${CS_DOMAIN} record to prefer: ${group
          .map((other) => other.email)
          .join(" / ")}`;
      }
      continue;
    }
    for (const plan of group) {
      if (plan === preferred) {
        continue;
      }
      plans.splice(plans.indexOf(plan), 1);
      skips.push({
        memberId: plan.memberId,
        name: plan.name,
        reason: `duplicate of ${preferred.name} [${preferred.memberId}]; kept ${preferred.email}`,
      });
    }
  }

  console.log(`database: ${databasePath}`);
  console.log(`members without a credential: ${rows.length}`);
  console.log(`would set a password for: ${plans.length}`);
  console.log(`skipped: ${skips.length}`);
  console.log("");
  for (const plan of plans) {
    const via = plan.source === "email" ? "" : ` (from ${plan.source})`;
    const note = plan.duplicateNote ? `  !! ${plan.duplicateNote}` : "";
    console.log(`  ${plan.email}${via}  <-  ${plan.name}${note}`);
  }
  if (skips.length) {
    console.log("\nskipped:");
    for (const skip of skips) {
      console.log(`  ${skip.name} [${skip.memberId}]: ${skip.reason}`);
    }
  }

  if (!write) {
    console.log("\nDry run. Re-run with --write to commit.");
    db.close();
    return;
  }

  // One transaction: a partial seed would leave the roster half able to log in, with no record of
  // where the run stopped.
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO adminbot_member_credentials (
       member_id, email, password_scrypt, claimed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const plan of plans) {
      // Hashed per member rather than once and reused: scryptSync salts each call, so 150 rows
      // holding one password still hold 150 distinct hashes.
      insert.run(plan.memberId, plan.email, hashPassword(password), now, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`\nWrote ${plans.length} credentials.`);
  db.close();
}

main();
