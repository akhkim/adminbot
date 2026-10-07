import { describe, expect, it } from "vitest";
import {
  pendingSubmissionLinks,
  paperSubmissionGridRows,
} from "../../scripts/adminbot-backfill-paper-links.js";

describe("Paper Submissions E/F link classification", () => {
  it("classifies mixed URLs without replacing existing artifacts or reading other columns", () => {
    const rows = [
      "",
      "Paper",
      "Venue",
      "https://docs.google.com/document/d/ignored/edit",
      "Draft: https://overleaf.com/read/viewtoken and https://docs.google.com/document/d/brainstorm/edit",
      "https://docs.google.com/presentation/d/slides/edit https://overleaf.com/1234567890abcdef#secret",
    ];
    expect(pendingSubmissionLinks({ brainstorming_doc_url: "kept" }, rows)).toEqual([
      { field: "overleaf_view_url", value: "https://overleaf.com/read/viewtoken" },
      { field: "google_slides_url", value: "https://docs.google.com/presentation/d/slides/edit" },
      { field: "overleaf_share_url", value: "https://overleaf.com/1234567890abcdef#secret" },
    ]);
  });
  it("ignores deadlines, spoofed hosts, credentials, unsupported paths and insecure URLs", () => {
    expect(
      pendingSubmissionLinks({}, [
        "",
        "",
        "",
        "",
        "2026-10-01 https://overleaf.com.evil.test/read/token https://user:pass@docs.google.com/document/d/secret/edit",
        "http://overleaf.com/read/token https://docs.google.com/spreadsheets/d/wrong/edit",
      ]),
    ).toEqual([]);
  });
});

it("runs the real CLI without Year, preserves existing fields and is idempotent", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-links-test-"));
  const database = path.join(dir, "synthetic.sqlite");
  const csv = path.join(dir, "papers.csv");
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE adminbot_papers (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)");
    const payload = { title: "Synthetic Paper", artifacts: { brainstorming_doc_url: "kept" } };
    db.prepare("INSERT INTO adminbot_papers VALUES (?, ?)").run("paper", JSON.stringify(payload));
    fs.writeFileSync(
      csv,
      "unused,Title,Venue,Authors,links,deadline\n,Synthetic Paper,,,https://docs.google.com/presentation/d/slides/edit,2026-10-01\n",
    );
    const run = (write = false) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/adminbot-backfill-paper-links.ts",
          "--csv",
          csv,
          "--database",
          database,
          "--paper-submissions",
          ...(write ? ["--write"] : []),
        ],
        { encoding: "utf8" },
      );
    const dry = run();
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("links from exact matches:  1");
    expect(
      JSON.parse(
        (db.prepare("SELECT payload_json FROM adminbot_papers").get() as { payload_json: string })
          .payload_json,
      ),
    ).toEqual(payload);
    const written = run(true);
    expect(written.status, written.stderr).toBe(0);
    const saved = JSON.parse(
      (db.prepare("SELECT payload_json FROM adminbot_papers").get() as { payload_json: string })
        .payload_json,
    );
    expect(saved.artifacts).toEqual({
      brainstorming_doc_url: "kept",
      google_slides_url: "https://docs.google.com/presentation/d/slides/edit",
    });
    expect(run(true).stdout).toContain("Nothing to write.");
    const backup = fs.readdirSync(dir).find((name) => name.includes(".backup-"));
    expect(backup).toBeTruthy();
    const restored = new DatabaseSync(path.join(dir, backup!));
    expect(
      JSON.parse(
        (
          restored.prepare("SELECT payload_json FROM adminbot_papers").get() as {
            payload_json: string;
          }
        ).payload_json,
      ),
    ).toEqual(payload);
    restored.close();
    fs.appendFileSync(csv, ",Synthetic Paper,,,https://docs.google.com/document/d/other/edit,\n");
    expect(run().stdout).toContain("matched by exact title:    0");
    const snapshot = path.join(dir, "cells.json");
    fs.writeFileSync(
      snapshot,
      JSON.stringify({
        sheets: [
          {
            properties: { title: "Paper submissions" },
            data: [
              {
                rowData: [
                  { values: [{}, { formattedValue: "Title" }] },
                  {
                    values: [
                      {},
                      { formattedValue: "Synthetic Paper" },
                      {},
                      {},
                      {},
                      {
                        chipRuns: [
                          {
                            chip: {
                              richLinkProperties: { uri: "https://overleaf.com/read/chiptoken" },
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const chipRun = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/adminbot-backfill-paper-links.ts",
        "--sheet-json",
        snapshot,
        "--database",
        database,
        "--write",
      ],
      { encoding: "utf8" },
    );
    expect(chipRun.status, chipRun.stderr).toBe(0);
    expect(
      JSON.parse(
        (db.prepare("SELECT payload_json FROM adminbot_papers").get() as { payload_json: string })
          .payload_json,
      ).artifacts.overleaf_view_url,
    ).toBe("https://overleaf.com/read/chiptoken");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("preserves E/F metadata links and rejects wrong tab or shifted ranges", () => {
  const grid = {
    sheets: [
      {
        properties: { title: "Paper submissions" },
        data: [
          {
            rowData: [
              { values: [{}, { formattedValue: "Title" }] },
              {
                values: [
                  {},
                  { formattedValue: "Synthetic Paper" },
                  {},
                  {},
                  { formattedValue: "Draft", hyperlink: "https://overleaf.com/read/token" },
                  {
                    formattedValue: "Brainstorm",
                    chipRuns: [
                      {
                        chip: {
                          richLinkProperties: {
                            uri: "https://docs.google.com/document/d/brainstorm/edit",
                          },
                        },
                      },
                    ],
                    textFormatRuns: [
                      {
                        format: {
                          link: { uri: "https://docs.google.com/presentation/d/slides/edit" },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const rows = paperSubmissionGridRows(grid);
  expect(rows[1][1]).toBe("Synthetic Paper");
  expect(
    pendingSubmissionLinks({}, rows[1])
      .map((link) => link.field)
      .toSorted(),
  ).toEqual(["brainstorming_doc_url", "google_slides_url", "overleaf_view_url"]);
  expect(() => paperSubmissionGridRows({ sheets: [] })).toThrow("one Paper Submissions");
  const shifted = {
    sheets: [{ ...grid.sheets[0], data: [{ ...grid.sheets[0].data[0], startColumn: 4 }] }],
  };
  expect(() => paperSubmissionGridRows(shifted)).toThrow("begin at A1");
});
