#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";

const [databasePath, sourceRoot, targetRoot] = process.argv.slice(2);
if (!databasePath || !sourceRoot || !targetRoot) {
  console.error(
    "usage: export-openclaw-cron-jobs.mjs <openclaw.sqlite> <source-root> <target-root>",
  );
  process.exit(2);
}

const allowedCreateFields = [
  "name",
  "agentId",
  "sessionKey",
  "description",
  "enabled",
  "deleteAfterRun",
  "schedule",
  "sessionTarget",
  "wakeMode",
  "payload",
  "delivery",
  "failureAlert",
];

function rewriteMachinePaths(value) {
  if (typeof value === "string") {
    return value.replaceAll(sourceRoot, targetRoot);
  }
  if (Array.isArray(value)) {
    return value.map(rewriteMachinePaths);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteMachinePaths(entry)]),
    );
  }
  return value;
}

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = database
    .prepare("select job_id, name, job_json from cron_jobs order by sort_order")
    .all();
  const jobs = rows.map((row) => {
    const stored = JSON.parse(row.job_json);
    const params = {};
    for (const field of allowedCreateFields) {
      if (stored[field] !== undefined) {
        params[field] = rewriteMachinePaths(stored[field]);
      }
    }
    if (!params.name || !params.schedule || !params.payload) {
      throw new Error(`cron job ${row.job_id} is missing required create fields`);
    }
    return { sourceId: row.job_id, params };
  });
  process.stdout.write(`${JSON.stringify({ version: 1, jobs }, null, 2)}\n`);
} finally {
  database.close();
}
