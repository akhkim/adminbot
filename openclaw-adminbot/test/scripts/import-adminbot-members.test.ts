import { describe, expect, it } from "vitest";
import { memberName, memberNotes, parseCsv } from "../../scripts/import-adminbot-members.js";

const HEADER = ",Joined month,Graduated month,Location,Email,Twitter,Research interests";

describe("parseCsv", () => {
  it("reads the exported sheet, whose first column carries no header", () => {
    const rows = parseCsv(
      `${HEADER}\nAda Lovelace,2024-01,,Toronto,ada@example.test,@ada,Causality\n`,
    );
    expect(rows).toHaveLength(1);
    expect(memberName(rows[0])).toBe("Ada Lovelace");
    expect(rows[0].Email).toBe("ada@example.test");
  });

  it("prefers an explicit Name column when the sheet has one", () => {
    const rows = parseCsv("Name,Email\nGrace Hopper,grace@example.test\n");
    expect(memberName(rows[0])).toBe("Grace Hopper");
  });
});

describe("memberNotes", () => {
  const row = {
    "Joined month": "2024-01",
    "Graduated month": "2026-06",
    Location: "Toronto",
    Twitter: "@ada",
    "Research interests": "Causality",
  } as Record<string, string>;

  it("writes the columns this sheet owns", () => {
    expect(memberNotes(row, "")).toBe(
      [
        "Imported from Jinesis Contact/Paper member CSV.",
        "Joined month: 2024-01",
        "Graduated month: 2026-06",
        "Location: Toronto",
        "Twitter: @ada",
        "Research interests: Causality",
      ].join("\n"),
    );
  });

  // Several importers write into the same keyed list. Dropping what this sheet does not know
  // about would lose survey answers and hand-written remarks on every re-import.
  it("keeps lines owned by other sources and refreshes only its own keys", () => {
    const existing = [
      "Source: Quick-Start Survey for Research Mentees",
      "Imported from Jinesis Contact/Paper member CSV.",
      "Joined month: 1999-01",
      "Career stage: PhD / MSc",
      "Supervision: co-supervised w/ Dehan Kong",
      "Location: Zurich",
    ].join("\n");

    const merged = memberNotes(row, existing);

    expect(merged).toContain("Source: Quick-Start Survey for Research Mentees");
    expect(merged).toContain("Career stage: PhD / MSc");
    expect(merged).toContain("Supervision: co-supervised w/ Dehan Kong");
    expect(merged).toContain("Joined month: 2024-01");
    expect(merged).toContain("Location: Toronto");
    expect(merged).not.toContain("Joined month: 1999-01");
    expect(merged).not.toContain("Location: Zurich");
    // The marker stays on exactly one line however many times the import runs.
    expect(merged.split("\n").filter((line) => line.startsWith("Imported from"))).toHaveLength(1);
  });

  it("omits a key entirely when the sheet leaves that cell blank", () => {
    expect(memberNotes({ Location: "   " }, "")).toBe(
      "Imported from Jinesis Contact/Paper member CSV.",
    );
  });
});
