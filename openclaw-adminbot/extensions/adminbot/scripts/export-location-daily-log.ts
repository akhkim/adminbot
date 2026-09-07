// Writes one member's daily location log to CSV.
//
//   npx tsx extensions/adminbot/scripts/export-location-daily-log.ts \
//     --db ~/adminbot-prod.sqlite --member zhijing-jin --out Zhijing-location.csv
//
// Re-running rewrites the whole file rather than appending. That is deliberate: the projection is
// a pure function of the observation history, so a rewrite is idempotent, and a late-arriving
// observation correctly changes the days it now covers. An append-only file would freeze the first
// guess for a day and never revise it -- which for carried days is exactly the wrong behaviour,
// since a carry is a placeholder waiting to be confirmed or replaced.
//
// `--from` defaults to the first observation on record: there is no honest way to report days
// before the log begins, and emitting a year of `unknown` rows to reach a requested start date
// makes a file look substantive when it holds nothing.
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AdminBotMemberLocationEntry } from "../src/contracts/actions.js";
import {
  countryDayTotals,
  dailyLocationRows,
  formatLocationDayCsv,
} from "../src/workflows/members/location-daily-log.js";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const dbPath = arg("db");
const memberId = arg("member");
const out = arg("out");
if (!dbPath || !memberId || !out) {
  console.error(
    "usage: --db <sqlite> --member <member_id> --out <csv> [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
  );
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const history = db
  .prepare(
    "SELECT payload_json FROM adminbot_member_locations WHERE member_id = ? ORDER BY observed_at",
  )
  .all(memberId)
  .map(
    (row) =>
      JSON.parse(
        String((row as { payload_json: string }).payload_json),
      ) as AdminBotMemberLocationEntry,
  );
db.close();

if (history.length === 0) {
  // Refusing to write an all-`unknown` file. A CSV of empty rows is indistinguishable at a glance
  // from a CSV of findings, and this is the case where saying so in words is the honest output.
  console.error(`No location observations recorded for "${memberId}". Nothing to export.`);
  process.exit(1);
}

const from = arg("from") ?? history[0]!.observed_at.slice(0, 10);
const to = arg("to") ?? new Date().toISOString().slice(0, 10);
const rows = dailyLocationRows({ history, from, to });
writeFileSync(out, formatLocationDayCsv(rows));

const observed = rows.filter((row) => row.basis === "observed").length;
const carried = rows.filter((row) => row.basis === "carried").length;
const unknown = rows.filter((row) => row.basis === "unknown").length;
console.log(
  `${out}: ${rows.length} days ${from}..${to} — ${observed} observed, ${carried} carried, ${unknown} unknown`,
);
console.log(`sources: ${[...new Set(history.map((entry) => entry.source))].join(", ")}`);
for (const total of countryDayTotals(rows)) {
  console.log(
    `  ${total.country}: ${total.observed_days} observed days, ${total.carried_days} carried`,
  );
}
