import { describe, expect, it } from "vitest";
import type { AdminBotCvChangeEvent, AdminBotCvEntry } from "../../contracts/actions.js";
import { renderCvDigestDocument } from "./digest-doc.js";

const NOW = new Date("2026-08-20T09:30:00.000Z");

function change(
  overrides: Partial<AdminBotCvChangeEvent> & { member_name: string; entry: AdminBotCvEntry },
): AdminBotCvChangeEvent {
  return {
    member_id: overrides.member_id ?? overrides.member_name.toLowerCase().replace(/\s+/gu, "-"),
    detected_at: "2026-08-20T09:00:00.000Z",
    recency: "recent",
    ...overrides,
  };
}

function position(title: string, organization: string): AdminBotCvEntry {
  return { kind: "position", title, organization, start: "2026-07" };
}

describe("renderCvDigestDocument", () => {
  it("heads the document with the date it was written", () => {
    const doc = renderCvDigestDocument(
      [change({ member_name: "Jane Doe", entry: position("Research Scientist", "NVIDIA") })],
      NOW,
    );
    expect(doc.markdown).toContain("# CV Updates");
    expect(doc.markdown).toContain("_Updated 20 August 2026_");
  });

  it("groups changes into dated sections, newest day first", () => {
    const doc = renderCvDigestDocument(
      [
        change({
          member_name: "Old News",
          detected_at: "2026-07-01T09:00:00.000Z",
          entry: position("Postdoc", "MIT"),
        }),
        change({
          member_name: "Fresh News",
          detected_at: "2026-08-20T09:00:00.000Z",
          entry: position("Research Scientist", "NVIDIA"),
        }),
      ],
      NOW,
    );
    const august = doc.markdown.indexOf("## 20 August 2026");
    const july = doc.markdown.indexOf("## 1 July 2026");
    expect(august).toBeGreaterThan(-1);
    expect(july).toBeGreaterThan(august);
    expect(doc.day_count).toBe(2);
    expect(doc.change_count).toBe(2);
  });

  it("credits one publication to every co-author instead of repeating it", () => {
    const paper: AdminBotCvEntry = {
      kind: "publication",
      title: "Attention Is Still All You Need",
      organization: "NeurIPS 2026",
      start: "2026-07",
    };
    const doc = renderCvDigestDocument(
      [
        change({ member_name: "Sam Lee", entry: paper }),
        change({ member_name: "Ana Ruiz", entry: paper }),
      ],
      NOW,
    );
    expect(doc.markdown).toContain("**Sam Lee and Ana Ruiz**");
    expect(doc.markdown.match(/Attention Is Still All You Need/gu)).toHaveLength(1);
  });

  // The ledger keeps backfilled history on purpose, but announcing a 2019 job as lab news reads
  // as a bug, so the document carries only what a newsletter would.
  it("leaves backfilled changes off the page", () => {
    const doc = renderCvDigestDocument(
      [
        change({
          member_name: "Backfilled",
          recency: "backfilled",
          entry: position("Intern", "Some Lab"),
        }),
      ],
      NOW,
    );
    expect(doc.markdown).not.toContain("Backfilled");
    expect(doc.change_count).toBe(0);
  });

  // A quiet week must still produce a publishable document: the writer refuses an empty body, and
  // blanking the doc would lose the previous run's content.
  it("still renders a body when nothing has been recorded", () => {
    const doc = renderCvDigestDocument([], NOW);
    expect(doc.markdown.trim()).not.toBe("");
    expect(doc.markdown).toContain("_Updated 20 August 2026_");
    expect(doc.day_count).toBe(0);
  });

  it("drops rows whose detected_at is not a date rather than opening an Invalid Date section", () => {
    const doc = renderCvDigestDocument(
      [change({ member_name: "Broken", detected_at: "not-a-date", entry: position("X", "Y") })],
      NOW,
    );
    expect(doc.markdown).not.toContain("Invalid Date");
    expect(doc.day_count).toBe(0);
  });

  it("renders the same document when run twice over an unchanged ledger", () => {
    const rows = [change({ member_name: "Jane Doe", entry: position("Scientist", "NVIDIA") })];
    expect(renderCvDigestDocument(rows, NOW).markdown).toBe(
      renderCvDigestDocument(rows, NOW).markdown,
    );
  });
});
