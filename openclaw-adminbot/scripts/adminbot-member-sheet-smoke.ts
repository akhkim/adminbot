#!/usr/bin/env tsx
// Proves the existing Sheets -> HTTP -> SQLite path against one synthetic member. All local
// state is disposable; neither production service settings nor database paths are accepted.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminBotMockService } from "../extensions/adminbot/src/api/server.js";
import {
  readGogSheetRows,
  readGogSheetTabs,
  type GogSheetTab,
} from "../extensions/adminbot/src/connectors/gog.js";
import { pollMemberSheet } from "./adminbot-member-sheet-poller.js";

const MEMBER_ID = "dev-sheet-person";
const INITIAL_LOCATION = "Toronto";
const HELP = `Usage:
  node --import tsx scripts/adminbot-member-sheet-smoke.ts --sheet URL_OR_ID [--tab NAME] [--dry-run]

Use a test tab with two columns and one person:
  AdminBot ID       Location
  dev-sheet-person Zurich

The URL's gid selects its tab; --tab overrides it. Without either, a single tab is selected
automatically. Google access uses your existing gog authentication (optionally GOG_ACCOUNT).
Reads Google Sheets only. Starts its own temporary local service and SQLite database.
--dry-run seeds Toronto locally and previews the import without applying the Sheet value.
See docs/development/member-sheet-smoke.md for setup.`;

export type SheetSmokeOptions = { sheet: string; tab?: string; dryRun?: boolean };
type SmokeService = ReturnType<typeof createAdminBotMockService>;
type SheetSmokeDeps = {
  readTabs?: (spreadsheetId: string) => Promise<GogSheetTab[]>;
  readRows?: (spreadsheetId: string, range: string) => Promise<string[][]>;
  createService?: typeof createAdminBotMockService;
  fetchImpl?: typeof fetch;
};

export function parseSheetSmokeArgs(args: string[]): SheetSmokeOptions | { help: true } {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { help: true };
  }
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--dry-run" && !dryRun) {
      dryRun = true;
    } else if ((flag === "--sheet" || flag === "--tab") && !values.has(flag)) {
      const value = args[++i]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      values.set(flag, value);
    } else {
      throw new Error(`Unknown or repeated option ${flag}; use --help`);
    }
  }
  const sheet = values.get("--sheet");
  if (!sheet) {
    throw new Error("--sheet is required; supply a test spreadsheet URL or ID (see --help)");
  }
  return { sheet, ...(values.has("--tab") ? { tab: values.get("--tab")! } : {}), dryRun };
}

export function parseSmokeSheetReference(input: string): { spreadsheetId: string; gid?: number } {
  const value = input.trim();
  if (/^[a-zA-Z0-9_-]+$/u.test(value)) {
    return { spreadsheetId: value };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--sheet must be a Google Sheets URL or spreadsheet ID");
  }
  const match = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/u.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    url.username ||
    url.password ||
    url.port ||
    !match ||
    match[1] === "e"
  ) {
    throw new Error(
      "Use the normal https://docs.google.com/spreadsheets/d/ID/edit URL, not a published link",
    );
  }
  const rawGid = new URLSearchParams(url.hash.slice(1)).get("gid") ?? url.searchParams.get("gid");
  if (rawGid !== null && (!/^\d+$/u.test(rawGid) || !Number.isSafeInteger(Number(rawGid)))) {
    throw new Error("The spreadsheet URL contains an invalid gid (tab ID)");
  }
  return { spreadsheetId: match[1], ...(rawGid === null ? {} : { gid: Number(rawGid) }) };
}

function selectTab(tabs: GogSheetTab[], requested: string | undefined, gid: number | undefined) {
  const choices = tabs.map((tab) => JSON.stringify(tab.title)).join(", ") || "(none)";
  const selected = requested
    ? tabs.find((tab) => tab.title === requested)
    : gid !== undefined
      ? tabs.find((tab) => tab.gid === gid)
      : tabs.length === 1
        ? tabs[0]
        : undefined;
  if (!selected) {
    throw new Error(
      `Could not select a tab${requested ? ` named ${JSON.stringify(requested)}` : gid !== undefined ? ` with gid ${gid}` : " automatically"}. Available tabs: ${choices}. Rerun with --tab "Tab name".`,
    );
  }
  return selected.title;
}

function validateSmokeSheet(matrix: string[][]): string {
  const header = matrix[0]?.map((cell) => cell.trim());
  if (header?.length !== 2 || header[0] !== "AdminBot ID" || header[1] !== "Location") {
    throw new Error('Use exactly two columns in row 1: "AdminBot ID", "Location" (in that order)');
  }
  const rows = matrix.slice(1).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length !== 1 || rows[0].length > 2 || rows[0][0]?.trim() !== MEMBER_ID) {
    throw new Error(`Use exactly one nonblank data row, with AdminBot ID ${MEMBER_ID}`);
  }
  const location = rows[0][1]?.trim();
  if (!location) {
    throw new Error("Location must be nonblank for this smoke test (for example, Zurich)");
  }
  return location;
}

async function googleRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /ENOENT|not found.*gog|gog.*not found/u.test(message)
      ? "Install gog or set GOG_BIN to its executable."
      : "Check gog authentication, GOG_ACCOUNT, and that your Google account can read this spreadsheet.";
    // Keep raw CLI output out of normal logs: it can contain account/keyring details.
    throw new Error(
      `Google Sheets read failed. ${hint} See docs/development/member-sheet-smoke.md.`,
      {
        cause: error,
      },
    );
  }
}

async function stopService(app: SmokeService): Promise<void> {
  try {
    if (app.server.listening) {
      await new Promise<void>((resolve, reject) => {
        app.server.close((error) => {
          if (error) {
            reject(new Error("Could not stop the temporary service", { cause: error }));
          } else {
            resolve();
          }
        });
        app.server.closeAllConnections();
      });
    }
  } finally {
    app.close();
  }
}

export async function runMemberSheetSmoke(options: SheetSmokeOptions, deps: SheetSmokeDeps = {}) {
  const { spreadsheetId, gid } = parseSmokeSheetReference(options.sheet);
  const tabs = await googleRead(() => (deps.readTabs ?? readGogSheetTabs)(spreadsheetId));
  const tab = selectTab(tabs, options.tab, gid);
  // Read the whole tab so extra columns/people cannot silently escape layout validation.
  const range = `'${tab.replaceAll("'", "''")}'`;
  const matrix = await googleRead(() =>
    (deps.readRows ?? ((id, selectedRange) => readGogSheetRows(id, { range: selectedRange })))(
      spreadsheetId,
      range,
    ),
  );
  const sheetLocation = validateSmokeSheet(matrix);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-sheet-smoke-"));
  const databasePath = path.join(directory, "smoke-dev.sqlite");
  const serviceToken = randomBytes(32).toString("hex");
  const createService = deps.createService ?? createAdminBotMockService;
  let app: SmokeService | undefined;
  const startService = async () => {
    app = createService({
      databasePath,
      serviceToken,
      allowedOrigins: [],
      calendarInviteRunner: async () => {},
      accountApprovedEmailRunner: async () => {},
      memberSheet: { spreadsheetId, tab, read: async () => matrix },
    });
    await app.listen(0, "127.0.0.1");
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine the temporary service port");
    }
    return `http://127.0.0.1:${address.port}`;
  };
  const closeService = async () => {
    const current = app;
    app = undefined;
    if (current) {
      await stopService(current);
    }
  };
  const poll = (serviceBaseUrl: string, dryRun: boolean) =>
    pollMemberSheet({
      spreadsheetId,
      range,
      serviceBaseUrl,
      serviceToken,
      dryRun,
      // Preview, apply, and repeat all use the same validated snapshot, even if someone edits
      // the Google Sheet while the check runs. Running the command again reads a fresh snapshot.
      readRows: async () => matrix,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  try {
    const baseUrl = await startService();
    const seeded = app!.service.upsertLabMember({
      id: MEMBER_ID,
      name: "Sheet Test Person",
      email: "sheet-person@example.test",
      privilege_level: "external_collaborator",
      location: INITIAL_LOCATION,
    });
    if (!seeded.ok) {
      throw new Error(`Could not seed synthetic member: ${seeded.error.message}`);
    }
    const preview = await poll(baseUrl, true);
    if (app!.store.getLabMember(MEMBER_ID)?.location !== INITIAL_LOCATION) {
      throw new Error("Dry run unexpectedly changed the member");
    }
    const applied = options.dryRun ? undefined : await poll(baseUrl, false);
    await closeService();
    const reopenedUrl = await startService();
    const after = app!.store.getLabMember(MEMBER_ID)?.location;
    const expected = options.dryRun ? INITIAL_LOCATION : sheetLocation;
    if (after !== expected) {
      throw new Error(
        `SQLite persistence check failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`,
      );
    }
    const repeated = options.dryRun ? undefined : await poll(reopenedUrl, false);
    if (repeated && repeated.updated !== 0) {
      throw new Error("Repeat import unexpectedly produced updates");
    }
    return {
      spreadsheetId,
      tab,
      before: INITIAL_LOCATION,
      sheetLocation,
      after,
      dryRun: options.dryRun === true,
      previewUpdates: preview.updated,
      appliedUpdates: applied?.updated ?? 0,
      repeatUpdates: repeated?.updated ?? null,
      persistenceVerified: true,
    };
  } finally {
    try {
      await closeService();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseSheetSmokeArgs(process.argv.slice(2));
  if ("help" in options) {
    console.log(HELP);
    return;
  }
  const result = await runMemberSheetSmoke(options);
  console.log(`Sheet tab: ${JSON.stringify(result.tab)}`);
  console.log(`Location before: ${JSON.stringify(result.before)}`);
  console.log(`Sheet location: ${JSON.stringify(result.sheetLocation)}`);
  console.log(`Dry-run preview: ${result.previewUpdates} update(s)`);
  console.log(`Location after reopening SQLite: ${JSON.stringify(result.after)}`);
  console.log(
    result.dryRun
      ? "PASS: dry run left the seeded SQLite value unchanged; no import applied."
      : `PASS: ${result.appliedUpdates} update(s) applied and persisted; repeat import: ${result.repeatUpdates} updates.`,
  );
  console.log("Temporary service stopped and database removed. Google Sheets was only read.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
