#!/usr/bin/env node
// Runs F from explicit CSV inputs and prints serializable review data. Nothing is persisted or sent.

import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { DEADLINE_VENUES } from "../extensions/adminbot/src/workflows/deadlines/generated/dataset.js";
import { createLocalWorkshopMatcher } from "../extensions/adminbot/src/workflows/papers/workshop-match-llm.js";
import {
  parseWorkshopAttendance,
  parseWorkshopNudgePapers,
} from "../extensions/adminbot/src/workflows/papers/workshop-nudges.csv.js";
import {
  matchWorkshopNudges,
  workshopProfilesFromDeadlines,
} from "../extensions/adminbot/src/workflows/papers/workshop-nudges.js";

const { values } = parseArgs({
  options: {
    papers: { type: "string" },
    attendance: { type: "string" },
    now: { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});

if (!values.papers) {
  throw new Error("--papers PATH is required");
}
const now = values.now ? new Date(values.now) : new Date();
if (!Number.isFinite(now.getTime())) {
  throw new Error("--now must be an ISO-8601 date or instant");
}

const paperCsv = await fs.readFile(values.papers, "utf8");
const attendanceCsv = values.attendance ? await fs.readFile(values.attendance, "utf8") : undefined;
const papers = parseWorkshopNudgePapers(paperCsv);
const attendance = parseWorkshopAttendance(attendanceCsv);
const workshops = workshopProfilesFromDeadlines(DEADLINE_VENUES, now);
const result = await matchWorkshopNudges({
  papers,
  workshops,
  attendance,
  match: createLocalWorkshopMatcher(),
  now,
});
const output = `${JSON.stringify(result, null, 2)}\n`;
if (values.out) {
  await fs.writeFile(values.out, output, "utf8");
  process.stderr.write(
    `Matched ${papers.length} papers against ${workshops.length} workshops; wrote ${values.out}\n`,
  );
} else {
  process.stdout.write(output);
}
