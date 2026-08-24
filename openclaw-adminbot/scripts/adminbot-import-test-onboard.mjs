#!/usr/bin/env node
// Import the lab spreadsheet's "Test Onboard" (R) and "Member Type" (S) columns onto the roster.
//
// Together they decide who the pre-meeting sweeps address, and both live in a spreadsheet on
// somebody's laptop. A sweep that had to open that file is a sweep that runs only
// when the laptop is open, so the number is copied onto the member record once and read from there
// afterwards. Re-running is safe: it writes the same value, and only for rows it can match.
//
// Matching is by email, never by name. Two people share a name on this roster already, and putting
// somebody else's batch on a member is worse than leaving the batch off.
//
//   node scripts/adminbot-import-test-onboard.mjs --file "<xlsx>" [--apply]
//   node scripts/adminbot-import-test-onboard.mjs --file "<xlsx>" --extract rows.json
//   node scripts/adminbot-import-test-onboard.mjs --rows rows.json [--apply]
//
// Two steps, because the two halves live on different machines: the spreadsheet is on somebody's
// laptop and the roster is on the deployment. `--extract` reads the sheet and writes the handful of
// fields it needs, touching no service and needing no session; `--rows` applies that file, needing
// neither the spreadsheet nor openpyxl. One-shot still works wherever both are available.
//
// Without --apply it prints what it would write and changes nothing. Needs ADMINBOT_SESSION (an
// admin member session) and optionally ADMINBOT_BASE -- which must name the deployment you mean,
// because the default is whatever AdminBot answers on this machine's own port, and that is very
// often not the one the sweep will run on.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
const rowsIndex = args.indexOf("--rows");
const rowsFile = rowsIndex >= 0 ? args[rowsIndex + 1] : undefined;
const extractIndex = args.indexOf("--extract");
const extractTo = extractIndex >= 0 ? args[extractIndex + 1] : undefined;
const apply = args.includes("--apply");
const BASE = process.env.ADMINBOT_BASE ?? "http://127.0.0.1:8765";
const SESSION = process.env.ADMINBOT_SESSION;

if (!file && !rowsFile) {
  console.error(
    "usage: --file <spreadsheet.xlsx> [--extract rows.json] [--apply]\n" +
      "       --rows rows.json [--apply]",
  );
  process.exit(1);
}
if (file && !existsSync(file)) {
  console.error(`no such spreadsheet: ${file}`);
  process.exit(1);
}
if (rowsFile && !existsSync(rowsFile)) {
  console.error(`no such rows file: ${rowsFile}`);
  process.exit(1);
}
// --extract never touches the service, so it needs no session. Everything else does.
if (!extractTo && !SESSION) {
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
    member_type = ws.cell(r, 19).value    # S: Member Type
    member_type = str(member_type).strip() if member_type else ""
    if batch is None and not member_type:
        continue
    emails = [ws.cell(r, 17).value, ws.cell(r, 5).value]   # Q: Slack email, E: correspondence
    emails = [str(e).strip().lower() for e in emails if e]
    if not emails:
        continue
    rows.append({
        "row": r,
        "name": ws.cell(r, 1).value,
        "batch": int(batch) if batch is not None else None,
        "member_type": member_type,
        "emails": emails,
    })
print(json.dumps(rows))
`;
const sheetRows = rowsFile
  ? JSON.parse(readFileSync(rowsFile, "utf8"))
  : JSON.parse(execFileSync("python3", ["-c", script, file], { encoding: "utf8" }));

if (extractTo) {
  writeFileSync(extractTo, `${JSON.stringify(sheetRows, null, 2)}\n`);
  console.log(
    `wrote ${sheetRows.length} row(s) to ${extractTo}\n` +
      `copy it across and apply with: --rows <file> --apply`,
  );
  process.exit(0);
}

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
  const patch = {};
  if (row.batch !== null && member.test_onboard_batch !== row.batch) {
    patch.test_onboard_batch = row.batch;
  }
  if (row.member_type && member.member_type !== row.member_type) {
    patch.member_type = row.member_type;
  }
  if (Object.keys(patch).length === 0) {
    continue;
  }
  changed += 1;
  const summary = [
    patch.test_onboard_batch !== undefined ? `batch ${patch.test_onboard_batch}` : null,
    patch.member_type !== undefined ? `type "${patch.member_type}"` : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`${apply ? "writing" : "would write"} ${summary} -> ${member.id} (${member.name})`);
  if (!apply) {
    continue;
  }
  const res = await fetch(`${BASE}/lab/members/${encodeURIComponent(member.id)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${SESSION}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: member.name, ...patch }),
  });
  if (!res.ok) {
    console.error(`  failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

console.log(
  `\n${sheetRows.length} row(s) with a batch or a member type · ${matched} matched to the roster · ` +
    `${changed} ${apply ? "written" : "to write"}`,
);

// Which of them the pre-meeting sweep would actually address, because the list above is every
// person in the sheet and reads alarmingly like a recipient list. It is not one: recording that
// somebody is an acquaintance or an external prof is what *keeps* them out of the sweep. Kept in
// step with collectPreRegistrationNudges in kernel/service.ts.
const tokens = (value) =>
  String(value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase());
const addressable = sheetRows.filter((row) => {
  const batched = row.batch !== null && row.batch >= 1 && row.batch <= 3;
  const full = tokens(row.member_type).includes("full");
  return (batched || full) && !tokens(row.member_type).includes("alumni");
});
console.log(
  `\n${addressable.length} of these rows are in scope for the pre-registration sweep ` +
    `(batch 1-3 or full, alumni excluded). The rest are recorded precisely so the sweep can tell ` +
    `they are not in scope -- an acquaintance with no member type on file looks the same as a ` +
    `full member the importer has not reached yet.\n` +
    `The sweep then narrows further to people who are on the roster and have at least one live ` +
    `paper, so the number it actually messages is smaller than this. ` +
    `GET /papers/pre-registration/pending is the count that matters.`,
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
