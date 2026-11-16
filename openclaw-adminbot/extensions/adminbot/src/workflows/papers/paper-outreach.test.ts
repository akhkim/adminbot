// Research outreach: who is told about which paper, and what can be sent without a person.
//
// The cases that matter are the ones where a wrong answer leaves the lab's name on something
// nobody wrote or checked: a paper offered to an institute its authors have nothing to do with, a
// placeholder mailed to a newsletter, a duplicate row under a header that means something else.
import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  acceptanceRowCells,
  acceptanceRows,
  ACCEPTANCE_SHEET_HEADER,
  composeOutreach,
  EMPTY_OUTREACH_CONFIG,
  missingAcceptanceRows,
  OUTREACH_OUTLETS,
  OUTREACH_SUMMARY_PLACEHOLDER,
  parseOutreachConfig,
  type OutreachConfig,
} from "./paper-outreach.js";

const ROSTER = [
  { id: "m_pi", name: "Ada Lovelace", member_type: "professor" },
  { id: "m_full", name: "Alan Turing", member_type: "full" },
  { id: "m_guest", name: "Edsger Dijkstra", member_type: "coauthor-minor" },
] as unknown as AdminBotLabMember[];

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "A Paper",
    authors: ["Alan Turing", "Ada Lovelace"],
    current_step: "arxiv_polish",
    venue_decision: "accept",
    accepted_venue: "NeurIPS 2026",
    artifacts: { arxiv_url: "https://arxiv.org/abs/2605.00001" },
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as AdminBotPaperRecord;
}

const CONFIG: OutreachConfig = {
  senior_authors: ["Grace Hopper"],
  outlets: {
    mpi_record: { to: ["records@example.org"], cc: [] },
    vector: { to: ["news@example.org"], cc: ["editor@example.org"] },
    sri: { to: ["roundup@example.org"], cc: [] },
    caif: { to: ["coop@example.org"], cc: [] },
    cls: { to: [], cc: [], form_url: "https://example.org/form" },
  },
};

function compose(papers: AdminBotPaperRecord[], config: OutreachConfig = CONFIG) {
  const plan = composeOutreach({
    papers,
    roster: ROSTER,
    piMemberId: "m_pi",
    venue: "NeurIPS 2026",
    config,
  });
  return {
    plan,
    draft: (key: string) => {
      const found = plan.drafts.find((draft) => draft.key === key);
      if (!found) {
        throw new Error(`no draft for ${key}`);
      }
      return found;
    },
  };
}

describe("parseOutreachConfig", () => {
  it("is empty, not an error, when nothing is configured", () => {
    expect(parseOutreachConfig(undefined)).toEqual(EMPTY_OUTREACH_CONFIG);
    expect(parseOutreachConfig("  ")).toEqual(EMPTY_OUTREACH_CONFIG);
  });

  it("reads recipients, a form link and an audience override", () => {
    const config = parseOutreachConfig(
      JSON.stringify({
        senior_authors: [" Grace Hopper "],
        outlets: {
          vector: { to: ["news@example.org"], cc: ["editor@example.org"], audience: "lab" },
          cls: { form_url: "https://example.org/form" },
        },
      }),
    );
    expect(config.error).toBeUndefined();
    expect(config.senior_authors).toEqual(["Grace Hopper"]);
    expect(config.outlets.vector).toEqual({
      to: ["news@example.org"],
      cc: ["editor@example.org"],
      audience: "lab",
    });
    expect(config.outlets.cls).toEqual({ to: [], cc: [], form_url: "https://example.org/form" });
  });

  it("refuses the whole configuration over one bad entry", () => {
    // Dropping the one bad address would send the email without the person who was meant to get it.
    for (const raw of [
      "not json",
      "[]",
      JSON.stringify({ outlets: { vector: { to: ["news@example.org", "not-an-address"] } } }),
      JSON.stringify({ outlets: { vector: { to: "news@example.org" } } }),
      JSON.stringify({ outlets: { nowhere: { to: ["news@example.org"] } } }),
      JSON.stringify({ outlets: { cls: { form_url: "http://example.org/form" } } }),
      JSON.stringify({ outlets: { vector: { audience: "everyone" } } }),
      JSON.stringify({ senior_authors: "Grace Hopper" }),
    ]) {
      const config = parseOutreachConfig(raw);
      expect(config.error).toMatch(/not usable/u);
      expect(config.outlets).toEqual({});
    }
  });
});

describe("composeOutreach", () => {
  it("drafts every outlet, and only for the chosen venue's accepted papers", () => {
    const { plan } = compose([
      paper(),
      paper({ id: "p2", title: "Elsewhere", accepted_venue: "ICLR 2027" }),
      paper({ id: "p3", title: "Pending", venue_decision: "pending", accepted_venue: undefined }),
    ]);
    expect(plan.drafts.map((draft) => draft.key)).toEqual(OUTREACH_OUTLETS.map((o) => o.key));
    expect(plan.papers.map((entry) => entry.id)).toEqual(["p1"]);
  });

  it("matches the venue however it was typed", () => {
    const plan = composeOutreach({
      papers: [paper()],
      roster: ROSTER,
      piMemberId: "m_pi",
      venue: "neurips  2026",
      config: CONFIG,
    });
    expect(plan.papers).toHaveLength(1);
  });

  it("routes a paper by who is on it", () => {
    const { draft } = compose([
      paper({ id: "pi", title: "With the PI" }),
      paper({ id: "senior", title: "With a senior", authors: ["Alan Turing", "Grace Hopper"] }),
      paper({
        id: "member",
        title: "Members only",
        authors: ["Alan Turing"],
        author_links: [{ name: "Alan Turing", member_id: "m_full" }],
      }),
      paper({
        id: "guest",
        title: "A visitor's paper",
        authors: ["Edsger Dijkstra"],
        author_links: [{ name: "Edsger Dijkstra", member_id: "m_guest" }],
      }),
    ]);
    expect(draft("vector").paper_ids).toEqual(["pi"]);
    expect(draft("mpi_record").paper_ids).toEqual(["senior"]);
    expect(draft("ellis").paper_ids).toEqual(["pi", "senior"]);
    // A minor co-author is on the roster but is not who "a paper from the lab" means.
    expect(draft("social_managers").paper_ids).toEqual(["pi", "member"]);
  });

  it("recognises the head professor by a recorded link when the printed name differs", () => {
    const { draft } = compose([
      paper({
        authors: ["Alan Turing", "A. A. Lovelace-King"],
        author_links: [
          { name: "Alan Turing", member_id: "m_full" },
          { name: "A. A. Lovelace-King", member_id: "m_pi" },
        ],
      }),
    ]);
    expect(draft("vector").paper_ids).toEqual(["p1"]);
  });

  it("lets configuration change which papers an outlet is told about", () => {
    const { draft } = compose(
      [
        paper({
          authors: ["Alan Turing"],
          author_links: [{ name: "Alan Turing", member_id: "m_full" }],
        }),
      ],
      { ...CONFIG, outlets: { vector: { to: ["news@example.org"], cc: [], audience: "lab" } } },
    );
    expect(draft("vector").paper_ids).toEqual(["p1"]);
    expect(draft("vector").audience).toBe("lab");
  });

  it("writes the department record the way the lab's own example reads", () => {
    const { draft } = compose([
      paper({ title: "First", authors: ["Alan Turing", "Grace Hopper"] }),
      paper({
        id: "p2",
        title: "Second",
        authors: ["Grace Hopper"],
        artifacts: { arxiv_url: "https://arxiv.org/abs/2605.00002" },
      }),
    ]);
    const record = draft("mpi_record");
    expect(record.body).toContain(
      "I wanted to share the following NeurIPS 2026 paper acceptances involving Grace Hopper:",
    );
    expect(record.body).toContain(
      "1. First — Alan Turing, Grace Hopper — https://arxiv.org/abs/2605.00001",
    );
    expect(record.body).toContain("2. Second — Grace Hopper — https://arxiv.org/abs/2605.00002");
    expect(record.body).toContain("additional information for the record");
    expect(record.subject).toBe("Jinesis Lab: 2 papers accepted at NeurIPS 2026");
    expect(record.sendable).toBe(true);
  });

  it("leads with the most prominent paper and keeps record order within a rank", () => {
    const { draft } = compose([
      paper({ id: "poster", title: "Poster", presentation_type: "poster" }),
      paper({ id: "plain-a", title: "Plain A" }),
      paper({ id: "oral", title: "Oral", presentation_type: "oral" }),
      paper({ id: "plain-b", title: "Plain B" }),
    ]);
    expect(draft("vector").paper_ids).toEqual(["oral", "poster", "plain-a", "plain-b"]);
    expect(draft("vector").body).toContain("• Oral (Oral)");
  });

  it("keeps a draft with an unwritten summary from being sent", () => {
    const { draft } = compose([paper()]);
    const roundup = draft("sri");
    expect(roundup.to).toEqual(["roundup@example.org"]);
    expect(roundup.body).toContain(
      `*A Paper* (*NeurIPS 2026*), Ada Lovelace (co-author) — ${OUTREACH_SUMMARY_PLACEHOLDER}`,
    );
    expect(roundup.needs_edit).toBe(true);
    expect(roundup.sendable).toBe(false);
  });

  it("fills a written summary in and lets the draft be sent", () => {
    const { draft } = compose([
      paper({
        artifacts: {
          arxiv_url: "https://arxiv.org/abs/2605.00001",
          outreach_summary: "  Shows that judges\n disagree. ",
        },
      }),
    ]);
    const roundup = draft("sri");
    expect(roundup.body).toContain("(co-author) — Shows that judges disagree. https://arxiv.org");
    expect(roundup.needs_edit).toBe(false);
    expect(roundup.sendable).toBe(true);
  });

  it("still holds a draft back while any one of its papers has no summary", () => {
    const { draft } = compose([
      paper({ artifacts: { arxiv_url: "https://arxiv.org/abs/1", outreach_summary: "Done." } }),
      paper({ id: "p2", title: "Another" }),
    ]);
    expect(draft("sri").needs_edit).toBe(true);
  });

  it("links the Drive PDF until the paper is on arXiv", () => {
    const drive = "https://drive.google.com/file/d/abc/view";
    const record = paper({ artifacts: { google_drive_pdf_url: drive } });
    expect(compose([record]).draft("vector").body).toContain(drive);
    expect(acceptanceRows([record])[0]?.paper_link).toBe(drive);
  });

  it("takes a typed topic as well as the title for the multi-agent newsletter", () => {
    const { draft } = compose([
      paper({
        title: "A Benchmark for Reading",
        artifacts: { arxiv_url: "https://arxiv.org/abs/1", topic: "Multi-agent safety" },
      }),
    ]);
    expect(draft("caif").paper_ids).toEqual(["p1"]);
  });

  it("says lead author only when the head professor is first", () => {
    const { draft } = compose([paper({ authors: ["Ada Lovelace", "Alan Turing"] })]);
    expect(draft("sri").body).toContain("Ada Lovelace (lead author)");
  });

  it("groups the LinkedIn form by presentation and still describes every paper", () => {
    const { draft } = compose([
      paper({ id: "s", title: "Starred", presentation_type: "spotlight" }),
      paper({ id: "a", title: "Poster One", presentation_type: "poster" }),
      paper({ id: "b", title: "Poster Two", presentation_type: "poster" }),
    ]);
    const post = draft("cls");
    expect(post.body).toContain("🌟 Spotlight:\n• Starred");
    expect(post.body).toContain("📌 Poster:\n• Poster One\n• Poster Two");
    expect(post.body.match(/^Authors: /gmu)).toHaveLength(3);
    expect(post.form_url).toBe("https://example.org/form");
    // A form is filled in by a person. It is never mailed, whatever is configured.
    expect(post.sendable).toBe(false);
  });

  it("offers the multi-agent newsletter only papers whose titles suggest it, and says so", () => {
    const { draft } = compose([
      paper({ id: "ma", title: "Cooperation Among Multi-Agent Systems" }),
      paper({ id: "other", title: "A Benchmark for Reading" }),
    ]);
    expect(draft("caif").paper_ids).toEqual(["ma"]);
    expect(draft("caif").notes.join(" ")).toMatch(/Check each one/u);
  });

  it("will not send without recipients, without papers, or without a link to give", () => {
    const unconfigured = compose([paper()], EMPTY_OUTREACH_CONFIG);
    expect(unconfigured.draft("vector").sendable).toBe(false);

    const none = compose([paper({ accepted_venue: "ICLR 2027" })]);
    expect(none.draft("vector").body).toBe("");
    expect(none.draft("vector").sendable).toBe(false);

    const linkless = compose([paper({ artifacts: {} })]);
    expect(linkless.draft("vector").body).toContain("link not recorded");
    expect(linkless.draft("vector").notes.join(" ")).toMatch(/no arXiv or Drive link/u);
    expect(linkless.draft("vector").sendable).toBe(false);
  });

  it("sends nothing at all on a broken configuration", () => {
    const { plan } = compose([paper()], {
      ...CONFIG,
      error: "outreach configuration is not usable: bad",
    });
    expect(plan.config_error).toMatch(/not usable/u);
    expect(plan.drafts.some((draft) => draft.sendable)).toBe(false);
  });

  it("explains an empty list when nobody is set as head professor", () => {
    const plan = composeOutreach({
      papers: [paper()],
      roster: ROSTER,
      venue: "NeurIPS 2026",
      config: CONFIG,
    });
    const vector = plan.drafts.find((draft) => draft.key === "vector");
    expect(vector?.paper_ids).toEqual([]);
    expect(vector?.notes.join(" ")).toMatch(/No head professor/u);
  });
});

describe("the acceptance sheet", () => {
  it("makes one row per accepted paper in the tab's column order", () => {
    const rows = acceptanceRows([
      paper({ title: "  Older  ", accepted_venue: "ICLR 2025", accepted_year: 2025 }),
      paper({ id: "p2", title: "Newer" }),
      paper({ id: "p3", title: "Rejected", venue_decision: "reject", accepted_venue: undefined }),
    ]);
    expect(rows.map(acceptanceRowCells)).toEqual([
      ["2026", "Newer", "NeurIPS", "Alan Turing, Ada Lovelace", "https://arxiv.org/abs/2605.00001"],
      ["2025", "Older", "ICLR", "Alan Turing, Ada Lovelace", "https://arxiv.org/abs/2605.00001"],
    ]);
  });

  it("leaves the year blank rather than guessing it from when the record was made", () => {
    const [row] = acceptanceRows([paper({ accepted_venue: "TMLR", artifacts: {} })]);
    expect(row).toMatchObject({ year: "", conference: "TMLR", paper_link: "" });
  });

  it("finds only the rows the tab lacks, however a person retyped them", () => {
    const rows = acceptanceRows([paper({ title: "Kept" }), paper({ id: "p2", title: "New" })]);
    const sheet = [
      [...ACCEPTANCE_SHEET_HEADER],
      // Hand-edited: different casing and spacing, and the authors cell rewritten.
      ["2026", "  kept ", "neurips", "A. Turing et al.", ""],
    ];
    expect(missingAcceptanceRows(rows, sheet).map((row) => row.title)).toEqual(["New"]);
  });

  it("treats the same title at another conference as another row", () => {
    const rows = acceptanceRows([paper({ title: "Kept" })]);
    const sheet = [[...ACCEPTANCE_SHEET_HEADER], ["2026", "Kept", "ICML", "", ""]];
    expect(missingAcceptanceRows(rows, sheet)).toHaveLength(1);
  });

  it("refuses a tab whose header is not the acceptance header", () => {
    const rows = acceptanceRows([paper()]);
    expect(() => missingAcceptanceRows(rows, [["name", "email"]])).toThrow(/first row must be/u);
    expect(() => missingAcceptanceRows(rows, [])).toThrow(/first row must be/u);
  });
});
