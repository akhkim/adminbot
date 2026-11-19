import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import { buildOutreachReadyMessage, outreachReadyVenues } from "./outreach-ready.js";

const paper = (id: string, title: string, extra: Partial<AdminBotPaperRecord>) =>
  ({ id, title, authors: [], current_step: "camera_ready", ...extra }) as AdminBotPaperRecord;

const papers = [
  paper("a", "Zebra Findings", { venue_decision: "accept", accepted_venue: "Findings of EMNLP", accepted_year: 2026 }),
  paper("b", "Alpha Main", { venue_decision: "accept", accepted_venue: "EMNLP ARR Commitment", accepted_year: 2026 }),
  paper("c", "Coling Paper", { venue_decision: "accept", accepted_venue: "LREC-COLING 202", accepted_year: 2026 }),
  paper("d", "Last Year", { venue_decision: "accept", accepted_venue: "EMNLP", accepted_year: 2025 }),
  paper("e", "Still Writing", { venue: "EMNLP 2026" }),
];

describe("outreachReadyVenues", () => {
  it("takes the venues of the new acceptances, each with every paper accepted there", () => {
    expect(outreachReadyVenues(papers, new Set(["a"]))).toEqual([
      {
        key: "emnlp 2026",
        label: "EMNLP 2026",
        papers: [
          { id: "b", title: "Alpha Main" },
          { id: "a", title: "Zebra Findings" },
        ],
        newly_accepted: 1,
      },
    ]);
  });

  it("returns one entry per venue, label order, and nothing for ids it does not know", () => {
    const venues = outreachReadyVenues(papers, new Set(["a", "b", "c", "missing"]));
    expect(venues.map((venue) => [venue.label, venue.newly_accepted])).toEqual([
      ["EMNLP 2026", 2],
      ["LREC-COLING 2026", 1],
    ]);
    expect(outreachReadyVenues(papers, new Set(["e"]))).toEqual([]);
  });
});

describe("buildOutreachReadyMessage", () => {
  it("names the venue, lists the papers and says nothing was sent", () => {
    const [venue] = outreachReadyVenues(papers, new Set(["c"]));
    expect(buildOutreachReadyMessage(venue!, "https://bot.example/mailing-list")).toBe(
      [
        ":tada: 1 paper accepted at *LREC-COLING 2026* -- the outreach drafts are ready.",
        "• Coling Paper",
        "",
        "Pick *LREC-COLING 2026* on the Mailing List tab to review them: https://bot.example/mailing-list",
        "Nothing has been sent; each draft goes out only when an admin sends it from the tab.",
      ].join("\n"),
    );
  });
});
