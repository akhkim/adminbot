#!/usr/bin/env node
// Import the lab spreadsheet's "Test Onboard" column onto the roster.
//
// The batch decides who the pre-meeting pre-registration sweep addresses, and it lives in a
// spreadsheet on somebody's laptop. A sweep that had to open that file is a sweep that runs only
// when the laptop is open, so the number is copied onto the member record once and read from there
// afterwards. Re-running is safe: it writes the same value, and only for rows it can match.
//
// Matching is by email, never by name. Two people share a name on this roster already, and putting
// somebody else's batch on a member is worse than leaving the batch off.
//
//   node scripts/adminbot-import-test-onboard.mjs --file "<xlsx>" [--apply]
//
// Without --apply it prints what it would write and changes nothing. Needs ADMINBOT_SESSION (an
// admin member session) and optionally ADMINBOT_BASE.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
const apply = args.includes("--apply");
const BASE = process.env.ADMINBOT_BASE ?? "http://127.0.0.1:8765";
const SESSION = process.env.ADMINBOT_SESSION;

if (!file || !existsSync(file)) {
  console.error("usage: --file <spreadsheet.xlsx> [--apply]");
  process.exit(1);
}
if (!SESSION) {
  console.error("set ADMINBOT_SESSION to an admin member session token");
  process.exit(1);
}

// python3 + openpyxl reads the sheet; node has no xlsx reader in this repo and adding one for a
// once-a-term import is not worth a dependency.
const script = `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb["Full Slack Member List"]
rows = []
for r in range(2, ws.max_row + 1):
    batch = ws.cell(r, 18).value          # R: Test Onboard
    if batch is None:
        continue
    emails = [ws.cell(r, 17).value, ws.cell(r, 5).value]   # Q: Slack email, E: correspondence
    emails = [str(e).strip().lower() for e in emails if e]
    if not emails:
        continue
    rows.append({"row": r, "name": ws.cell(r, 1).value, "batch": int(batch), "emails": emails})
print(json.dumps(rows))
`;
const sheetRows = JSON.parse(execFileSync("python3", ["-c", script, file], { encoding: "utf8" }));

const membersRes = await fetch(`${BASE}/lab/members`, {
  headers: { Authorization: `Bearer ${SESSION}` },
});
if (!membersRes.ok) {
  console.error(`could not read the roster: ${membersRes.status} ${await membersRes.text()}`);
  process.exit(1);
}
const members = (await membersRes.json()).members ?? [];
const byEmail = new Map();
for (const member of members) {
  for (const value of [member.email, member.correspondence_email, member.calendar_email]) {
    if (typeof value === "string" && value.trim()) {
      byEmail.set(value.trim().toLowerCase(), member);
    }
  }
}

let matched = 0;
let changed = 0;
const unmatched = [];
for (const row of sheetRows) {
  const member = row.emails.map((email) => byEmail.get(email)).find(Boolean);
  if (!member) {
    unmatched.push(`row ${row.row}: ${row.name ?? "(no name)"} <${row.emails[0]}>`);
    continue;
  }
  matched += 1;
  if (member.test_onboard_batch === row.batch) {
    continue;
  }
  changed += 1;
  console.log(
    `${apply ? "writing" : "would write"} batch ${row.batch} -> ${member.id} (${member.name})`,
  );
  if (!apply) {
    continue;
  }
  const res = await fetch(`${BASE}/lab/members/${encodeURIComponent(member.id)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${SESSION}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: member.name, test_onboard_batch: row.batch }),
  });
  if (!res.ok) {
    console.error(`  failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

console.log(
  `\n${sheetRows.length} batched row(s) in the sheet · ${matched} matched to the roster · ${changed} ${apply ? "written" : "to write"}`,
);
if (unmatched.length > 0) {
  // Named individually: an unmatched row is somebody whose address the roster does not carry, and
  // a count alone would never get anybody to fix it.
  console.log(`\n${unmatched.length} row(s) the roster could not match by email:`);
  for (const line of unmatched) {
    console.log(`  ${line}`);
  }
}
if (!apply) {
  console.log("\ndry run — re-run with --apply to write");
}
