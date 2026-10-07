import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createAdminBotMockService } from "../../extensions/adminbot/src/api/server.js";
import {
  parseSheetSmokeArgs,
  parseSmokeSheetReference,
  runMemberSheetSmoke,
} from "../../scripts/adminbot-member-sheet-smoke.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const validRows = () => [
  ["AdminBot ID", "Location"],
  ["dev-sheet-person", "Zurich"],
];

function harness(rows = validRows()) {
  const apps: Array<{ app: ReturnType<typeof createAdminBotMockService>; databasePath: string }> =
    [];
  const requests: Array<{ method: string; pathname: string; status: number }> = [];
  const readTabs = vi.fn(async () => [{ title: "Sync Test", gid: 42 }]);
  const readRows = vi.fn(async () => rows);
  const createService: typeof createAdminBotMockService = (options) => {
    const app = createAdminBotMockService(options);
    apps.push({ app, databasePath: options!.databasePath! });
    return app;
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    requests.push({
      method: init?.method ?? "GET",
      pathname: new URL(input instanceof Request ? input.url : input).pathname,
      status: response.status,
    });
    return response;
  };
  return {
    apps,
    requests,
    deps: { readTabs, readRows, createService, fetchImpl },
    expectCleanedUp() {
      for (const { app, databasePath } of apps) {
        expect(app.server.listening).toBe(false);
        expect(fs.existsSync(path.dirname(databasePath))).toBe(false);
      }
    },
  };
}

describe("member Sheet smoke CLI inputs", () => {
  it("requires an explicit spreadsheet and rejects accidental options", () => {
    expect(parseSheetSmokeArgs(["--help"])).toEqual({ help: true });
    expect(
      parseSheetSmokeArgs(["--sheet", "test-sheet", "--tab", "Sync Test", "--dry-run"]),
    ).toEqual({
      sheet: "test-sheet",
      tab: "Sync Test",
      dryRun: true,
    });
    for (const args of [
      [],
      ["--sheet"],
      ["--sheet", "--dry-run"],
      ["--database", "live.sqlite"],
      ["--sheet", "one", "--sheet", "two"],
    ]) {
      expect(() => parseSheetSmokeArgs(args)).toThrow();
    }
  });

  it("accepts IDs, URL fragments, and query gids including zero", () => {
    expect(parseSmokeSheetReference("test-sheet_1")).toEqual({ spreadsheetId: "test-sheet_1" });
    expect(
      parseSmokeSheetReference("https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=42"),
    ).toEqual({ spreadsheetId: "test-sheet", gid: 42 });
    expect(
      parseSmokeSheetReference("https://docs.google.com/spreadsheets/d/test-sheet/edit?gid=0"),
    ).toEqual({ spreadsheetId: "test-sheet", gid: 0 });
  });

  it.each([
    "",
    "not a sheet",
    "https://example.test/spreadsheets/d/test/edit",
    "https://docs.google.com/spreadsheets/d/e/published/pubhtml",
    "https://docs.google.com/spreadsheets/d/test/edit#gid=oops",
  ])("rejects invalid or published references: %s", (input) => {
    expect(() => parseSmokeSheetReference(input)).toThrow();
  });
});

describe("member Sheet smoke import", () => {
  it("imports through real HTTP, reopens SQLite, and repeats without another write", async () => {
    const h = harness();
    const result = await runMemberSheetSmoke({ sheet: "test-sheet" }, h.deps);
    expect(result).toMatchObject({
      before: "Toronto",
      sheetLocation: "Zurich",
      after: "Zurich",
      previewUpdates: 1,
      appliedUpdates: 1,
      repeatUpdates: 0,
      persistenceVerified: true,
    });
    expect(h.apps).toHaveLength(2);
    expect(h.apps[0].databasePath).toBe(h.apps[1].databasePath);
    expect(h.requests.filter((request) => request.method === "PUT")).toEqual([
      { method: "PUT", pathname: "/lab/members/dev-sheet-person", status: 200 },
    ]);
    expect(h.deps.readRows).toHaveBeenCalledExactlyOnceWith("test-sheet", "'Sync Test'");
    h.expectCleanedUp();
  });

  it("dry run previews the change but preserves Toronto on disk and sends no PUT", async () => {
    const h = harness();
    const result = await runMemberSheetSmoke({ sheet: "test-sheet", dryRun: true }, h.deps);
    expect(result).toMatchObject({
      after: "Toronto",
      previewUpdates: 1,
      appliedUpdates: 0,
      repeatUpdates: null,
      dryRun: true,
      persistenceVerified: true,
    });
    expect(h.requests.every((request) => request.method === "GET")).toBe(true);
    h.expectCleanedUp();
  });

  it("accepts the unchanged Toronto case without pretending a write occurred", async () => {
    const h = harness([
      ["AdminBot ID", "Location"],
      ["dev-sheet-person", "Toronto"],
    ]);
    expect(await runMemberSheetSmoke({ sheet: "test-sheet" }, h.deps)).toMatchObject({
      previewUpdates: 0,
      appliedUpdates: 0,
      repeatUpdates: 0,
    });
    expect(h.requests.every((request) => request.method === "GET")).toBe(true);
    h.expectCleanedUp();
  });

  it("uses gid, allows an explicit tab override, and quotes tab names", async () => {
    const h = harness();
    h.deps.readTabs.mockResolvedValue([
      { title: "First", gid: 0 },
      { title: "Person's Test", gid: 42 },
    ]);
    await runMemberSheetSmoke(
      { sheet: "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=42", dryRun: true },
      h.deps,
    );
    expect(h.deps.readRows).toHaveBeenLastCalledWith("test-sheet", "'Person''s Test'");
    await runMemberSheetSmoke(
      {
        sheet: "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=42",
        tab: "First",
        dryRun: true,
      },
      h.deps,
    );
    expect(h.deps.readRows).toHaveBeenLastCalledWith("test-sheet", "'First'");
    h.expectCleanedUp();
  });

  it("lists ambiguous tabs and refuses missing tab selections before reading rows", async () => {
    const h = harness();
    h.deps.readTabs.mockResolvedValue([
      { title: "First", gid: 0 },
      { title: "Second", gid: 42 },
    ]);
    for (const options of [
      { sheet: "test-sheet" },
      { sheet: "test-sheet", tab: "Missing" },
      { sheet: "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=99" },
    ]) {
      await expect(runMemberSheetSmoke(options, h.deps)).rejects.toThrow(
        /Available tabs: "First", "Second".*--tab/u,
      );
    }
    expect(h.deps.readRows).not.toHaveBeenCalled();
    expect(h.apps).toHaveLength(0);
  });

  it.each(
    [
      [],
      [
        ["Name", "Location"],
        ["Someone", "Zurich"],
      ],
      [
        ["AdminBot ID", "Location", "Privilege Level"],
        ["dev-sheet-person", "Zurich", "admin"],
      ],
      [
        ["AdminBot ID", "Location"],
        ["dev-sheet-person", "Zurich"],
        ["dev-sheet-person", "London"],
      ],
      [
        ["AdminBot ID", "Location"],
        ["unknown-member", "Zurich"],
      ],
      [
        ["AdminBot ID", "Location"],
        ["", "Zurich"],
      ],
      [
        ["AdminBot ID", "Location"],
        ["dev-sheet-person", ""],
      ],
    ].map((rows) => ({ rows })),
  )("rejects invalid layout before creating local state: $rows", async ({ rows }) => {
    const h = harness(rows);
    await expect(runMemberSheetSmoke({ sheet: "test-sheet" }, h.deps)).rejects.toThrow(
      /Use exactly|Location must/u,
    );
    expect(h.apps).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
  });

  it("explains missing gog and denied reads without printing raw credential details", async () => {
    const h = harness();
    h.deps.readTabs.mockRejectedValueOnce(new Error("spawn gog ENOENT"));
    await expect(runMemberSheetSmoke({ sheet: "test-sheet" }, h.deps)).rejects.toThrow(
      /Install gog/u,
    );
    h.deps.readRows.mockRejectedValueOnce(new Error("403 private-keyring-detail"));
    await expect(runMemberSheetSmoke({ sheet: "test-sheet" }, h.deps)).rejects.toThrow(
      /Check gog authentication/u,
    );
    expect(h.apps).toHaveLength(0);
  });

  it("fails on denied HTTP writes and still closes the database and listener", async () => {
    const h = harness();
    const rejectedFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (init?.method === "PUT") {
        headers.set("authorization", "Bearer invalid-smoke-token");
      }
      return h.deps.fetchImpl(input, { ...init, headers });
    };
    await expect(
      runMemberSheetSmoke({ sheet: "test-sheet" }, { ...h.deps, fetchImpl: rejectedFetch }),
    ).rejects.toThrow(/PUT .* failed: 401/u);
    expect(h.requests.at(-1)?.status).toBe(401);
    expect(h.apps).toHaveLength(1);
    h.expectCleanedUp();
  });

  it("cleans up if binding the service fails", async () => {
    const h = harness();
    const createService: typeof createAdminBotMockService = (options) => {
      const app = h.deps.createService(options);
      app.listen = async () => {
        throw new Error("synthetic listen failure");
      };
      return app;
    };
    await expect(
      runMemberSheetSmoke({ sheet: "test-sheet" }, { ...h.deps, createService }),
    ).rejects.toThrow("synthetic listen failure");
    h.expectCleanedUp();
  });

  it("runs the actual CLI and Google adapter with a synthetic read-only gog executable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-smoke-gog-"));
    const executable = path.join(directory, "gog");
    fs.writeFileSync(
      executable,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('--readonly') || !args.includes('test-sheet')) process.exit(3);
if (args.includes('metadata')) console.log(JSON.stringify({sheets: [{properties: {title: 'Sync Test', sheetId: 42}}]}));
else if (args.includes('get')) console.log(JSON.stringify({values: ${JSON.stringify(validRows())}}));
else process.exit(4);
`,
      { mode: 0o700 },
    );
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/adminbot-member-sheet-smoke.ts",
          "--sheet",
          "https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=42",
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, GOG_BIN: executable, GOG_ACCOUNT: "synthetic@example.test" },
          timeout: 30_000,
        },
      );
      expect(stdout).toContain('Location after reopening SQLite: "Zurich"');
      expect(stdout).toContain(
        "PASS: 1 update(s) applied and persisted; repeat import: 0 updates.",
      );
      expect(stdout).toContain("Temporary service stopped and database removed.");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 35_000);
});
