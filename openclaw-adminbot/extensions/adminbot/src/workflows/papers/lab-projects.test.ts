import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import { buildLabProjects, type AdminBotLabProjectSources } from "./lab-projects.js";

const NOW = new Date("2026-11-01T12:00:00Z");

function paper(fields: Partial<AdminBotPaperRecord> & { id: string }): AdminBotPaperRecord {
  return {
    title: `Paper ${fields.id}`,
    authors: [],
    current_step: "overleaf_writing",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...fields,
  } as AdminBotPaperRecord;
}

function member(id: string, name: string): AdminBotLabMember {
  return { id, name, email: `${id}@example.test` } as AdminBotLabMember;
}

function sources(overrides: Partial<AdminBotLabProjectSources>): AdminBotLabProjectSources {
  return {
    papers: [],
    roster: [member("alice", "Alice Synthetic"), member("bob", "Bob Synthetic")],
    slots: () => [],
    drafts: () => [],
    weeklyUpdates: [],
    helpRequests: [],
    now: NOW,
    ...overrides,
  };
}

const slot = (fields: Partial<AdminBotPaperSlotRecord>): AdminBotPaperSlotRecord =>
  ({ paper_id: "p", status: "provided", ...fields }) as AdminBotPaperSlotRecord;

describe("buildLabProjects", () => {
  it("prefers the paper itself, then the repository, then the project doc", () => {
    const papers = [
      paper({
        id: "arxiv",
        artifacts: {
          arxiv_url: "https://arxiv.org/abs/2601.00001",
          github_url: "https://github.com/x/y",
        },
      }),
      paper({ id: "repo", artifacts: { github_url: "https://github.com/x/y" } }),
      paper({ id: "doc" }),
      paper({ id: "none" }),
    ];
    const rows = buildLabProjects(
      sources({
        papers,
        slots: (id) =>
          id === "doc"
            ? [slot({ slot: "project_folder", url: "https://docs.google.com/document/d/weekly" })]
            : [],
      }),
    );
    const primary = Object.fromEntries(rows.map((row) => [row.paper_id, row.links.primary]));
    expect(primary.arxiv).toEqual({ kind: "arxiv", url: "https://arxiv.org/abs/2601.00001" });
    expect(primary.repo).toEqual({ kind: "github", url: "https://github.com/x/y" });
    expect(primary.doc).toEqual({
      kind: "project_doc",
      url: "https://docs.google.com/document/d/weekly",
    });
    expect(primary.none).toBeNull();
  });

  it("reads slides and poster from their slots first and ignores links marked invalid", () => {
    const [row] = buildLabProjects(
      sources({
        papers: [
          paper({ id: "p", artifacts: { google_slides_url: "https://docs.google.com/old" } }),
        ],
        slots: () => [
          slot({ slot: "slides", url: "https://docs.google.com/presentation/d/new" }),
          slot({ slot: "poster", status: "invalid", url: "https://example.test/poster.pdf" }),
        ],
      }),
    );
    expect(row?.links.slides).toEqual({ url: "https://docs.google.com/presentation/d/new" });
    expect(row?.links.poster).toBeNull();
  });

  it("names roster members, drops emailed authors and never carries credentials or prose", () => {
    const [row] = buildLabProjects(
      sources({
        papers: [
          paper({
            id: "p",
            alias: "syn",
            authors: ["Alice Synthetic", "outside@example.test", "Carol Outside"],
            author_links: [
              { name: "Alice Synthetic", member_id: "alice" },
              { name: "Carol Outside", email: "carol@example.test" },
            ],
            notes: "secret note",
            artifacts: {
              topic: "synthetic topic",
              overleaf_share_url: "https://www.overleaf.com/9999tokensecret",
            },
          }),
        ],
        weeklyUpdates: [
          {
            paper_id: "p",
            member_id: "alice",
            week_start: "2026-10-26",
            body: "weekly body text",
            created_at: "2026-10-30T00:00:00Z",
            updated_at: "2026-10-30T00:00:00Z",
          },
        ],
        helpRequests: [
          { paper_id: "p", tags: ["nlp", " eval "], status: "open" },
          { paper_id: "p", tags: ["closed-tag"], status: "closed" },
        ] as AdminBotLabProjectSources["helpRequests"],
      }),
    );
    expect(row?.members).toEqual([{ member_id: "alice", name: "Alice Synthetic" }]);
    expect(row?.authors).toEqual(["Alice Synthetic", "Carol Outside"]);
    expect(row?.links.slack_channel).toBe("proj-syn");
    expect(row?.tags).toEqual(["nlp", "eval"]);
    expect(row?.last_update_at).toBe("2026-10-30T00:00:00Z");
    expect(row?.last_weekly_update).toEqual({
      week_start: "2026-10-26",
      member_id: "alice",
      name: "Alice Synthetic",
      updated_at: "2026-10-30T00:00:00Z",
    });
    const text = JSON.stringify(row);
    for (const leaked of ["9999tokensecret", "carol@example.test", "secret note", "weekly body"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("tells active, dormant, completed and rejected projects apart", () => {
    const rows = buildLabProjects(
      sources({
        papers: [
          paper({ id: "active" }),
          paper({ id: "dormant", created_at: "2024-01-01T00:00:00Z" }),
          paper({ id: "done", artifacts: { completed_at: "2026-10-01" } }),
          paper({ id: "rejected", venue_decision: "reject" }),
        ],
      }),
    );
    expect(Object.fromEntries(rows.map((row) => [row.paper_id, row.status]))).toEqual({
      active: "active",
      dormant: "dormant",
      done: "completed",
      rejected: "rejected",
    });
  });
});
