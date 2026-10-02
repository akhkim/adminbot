#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [openclawCli, bundlePath] = process.argv.slice(2);
if (!openclawCli || !bundlePath) {
  console.error("usage: import-openclaw-cron-jobs.mjs <openclaw.mjs> <bundle.json>");
  process.exit(2);
}

const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
if (bundle?.version !== 1 || !Array.isArray(bundle.jobs)) {
  throw new Error("unsupported cron export bundle");
}

function callGateway(method, params) {
  const stdout = execFileSync(
    process.execPath,
    [
      openclawCli,
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--timeout",
      "30000",
      "--json",
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

const existing = [];
for (let offset = 0; ; offset += 200) {
  const page = callGateway("cron.list", {
    includeDisabled: true,
    limit: 200,
    offset,
  });
  const jobs = Array.isArray(page?.jobs) ? page.jobs : [];
  existing.push(...jobs);
  if (jobs.length < 200) break;
}

for (const entry of bundle.jobs) {
  const params = entry?.params;
  if (!params?.name || !params?.schedule || !params?.payload) {
    throw new Error(`invalid exported cron job: ${entry?.sourceId ?? "unknown"}`);
  }
  const matches = existing.filter((job) => job?.name === params.name);
  if (matches.length > 1) {
    throw new Error(`multiple Aurora cron jobs already use the name: ${params.name}`);
  }
  if (matches.length === 1) {
    callGateway("cron.update", { id: matches[0].id, patch: params });
    console.log(`updated: ${params.name}`);
  } else {
    const added = callGateway("cron.add", params);
    existing.push(added);
    console.log(`created: ${params.name}`);
  }
}

console.log(`synced=${bundle.jobs.length}`);
