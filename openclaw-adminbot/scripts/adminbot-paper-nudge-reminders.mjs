#!/usr/bin/env node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const spreadsheetId = "1dLqwcWo-gmzQ9TOtRgoSpYguKsh-t_uG7_S-JnOcllY";
const targetGid = 1634319760;
const zhijingSlackTarget = "user:U07D6SZ7R9V";
const sheetReadRangeColumns = "A:P";
const googleCli = process.env.GOG_BIN?.trim() || findGoogleCli();
const configuredOpenClawCli = normalizeExecutableOverride(process.env.OPENCLAW_CLI);
const openclawCli = configuredOpenClawCli || process.execPath;
const openclawArgsPrefix = configuredOpenClawCli
  ? []
  : [fileURLToPath(new URL("../openclaw.mjs", import.meta.url))];

const metadata = await readJson(googleCli, [
  "sheets",
  "spreadsheets",
  "get",
  "--params",
  JSON.stringify({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  }),
  "--format",
  "json",
]);
const sheetTitle = findSheetTitle(metadata, targetGid);
const valuesPayload = await readJson(googleCli, [
  "sheets",
  "+read",
  "--spreadsheet",
  spreadsheetId,
  "--range",
  `${quoteSheetName(sheetTitle)}!${sheetReadRangeColumns}`,
  "--format",
  "json",
]);
const rows = extractValues(valuesPayload);
const matches = findPapersNeedingNudge(rows);

if (matches.length === 0) {
  console.log("NO_REPLY");
  process.exit(0);
}

const lines = [
  `Paper nudge check found ${matches.length} paper${matches.length === 1 ? "" : "s"} needing author follow-up.`,
  "",
  ...matches.map((paper) => {
    const linkStatus = paper.columnP
      ? `column P is a Drive link: ${paper.columnP}`
      : "column P is empty";
    return `- Row ${paper.rowNumber}: ${paper.label} (${linkStatus})`;
  }),
  "",
  "Please nudge the authors of the listed paper(s).",
];

await run(
  openclawCli,
  [
    ...openclawArgsPrefix,
    "message",
    "send",
    "--channel",
    "slack",
    "--target",
    zhijingSlackTarget,
    "--message",
    lines.join("\n"),
    "--json",
  ],
  { maxBuffer: 1024 * 1024, timeout: 60_000 },
);
console.log("NO_REPLY");

function findGoogleCli() {
  // The systemd unit's PATH misses the npm global bin dir, so resolve it under $HOME rather than
  // relying on a bare lookup that ENOENTs there.
  return process.env.GWS_BIN?.trim() || path.join(os.homedir(), ".npm-global", "bin", "gws");
}

function normalizeExecutableOverride(value) {
  const text = value?.trim();
  if (!text || text === "0" || text === "1" || text === "true" || text === "false") {
    return "";
  }
  return text;
}

async function readJson(command, args) {
  let result;
  try {
    result = await run(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    if (stdout) {
      const payload = JSON.parse(extractJsonText(stdout));
      if (payload?.error?.message) {
        throw new Error(payload.error.message, { cause: error });
      }
    }
    throw error;
  }
  const stdout = result.stdout.trim();
  if (!stdout) {
    throw new Error(`${command} ${args.join(" ")} returned no JSON output`);
  }
  const payload = JSON.parse(extractJsonText(stdout));
  if (payload?.error?.message) {
    throw new Error(payload.error.message);
  }
  return payload;
}

function extractJsonText(stdout) {
  const firstObject = stdout.indexOf("{");
  const firstArray = stdout.indexOf("[");
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length === 0) {
    throw new Error("Expected JSON output, got: " + stdout.slice(0, 200));
  }
  return stdout.slice(Math.min(...starts));
}

function findSheetTitle(metadata, gid) {
  const sheets = Array.isArray(metadata?.sheets) ? metadata.sheets : [];
  const match = sheets.find((sheet) => sheet?.properties?.sheetId === gid);
  const title = match?.properties?.title;
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(`Could not find sheet title for gid ${gid}`);
  }
  return title.trim();
}

function quoteSheetName(title) {
  return `${String.fromCharCode(39)}${title.replaceAll(String.fromCharCode(39), String.fromCharCode(39).repeat(2))}${String.fromCharCode(39)}`;
}

function extractValues(payload) {
  if (Array.isArray(payload?.values)) {
    return payload.values;
  }
  if (Array.isArray(payload?.data?.values)) {
    return payload.data.values;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  throw new Error("Sheets read response did not contain a values array");
}

function findPapersNeedingNudge(rows) {
  return rows
    .slice(1)
    .map((row, index) => ({ row: normalizeRow(row), rowNumber: index + 2 }))
    .filter(({ row }) => row.some((cell) => cell))
    .filter(({ row }) => !isPositionPaper(row))
    .filter(({ row }) => columnPNeedsNudge(row[15]))
    .map(({ row, rowNumber }) => ({
      rowNumber,
      label: paperLabel(row),
      columnP: normalizeCell(row[15]),
    }));
}

function normalizeRow(row) {
  return Array.isArray(row) ? row.map(normalizeCell) : [];
}

function normalizeCell(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isPositionPaper(row) {
  return row.some((cell) => /\bposition\s+paper\b/iu.test(cell));
}

function columnPNeedsNudge(value) {
  const text = normalizeCell(value);
  return !text || isGoogleDriveLink(text);
}

function isGoogleDriveLink(text) {
  try {
    return new URL(text).hostname === "drive.google.com";
  } catch {
    return false;
  }
}

function paperLabel(row) {
  const title = row.find((cell) => cell && !isGoogleDriveLink(cell));
  return title || "Untitled paper";
}
