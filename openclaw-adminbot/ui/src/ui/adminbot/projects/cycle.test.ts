// The conference line the social-draft settings start from, so nobody retypes what the card holds.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { announcementVenue } from "./cycle.ts";

const paper = (fields: Partial<AdminBotPaperRecord>) => fields as AdminBotPaperRecord;

describe("announcementVenue", () => {
  it("names venue, year and presentation format", () => {
    expect(
      announcementVenue(
        paper({ accepted_venue: "EMNLP", accepted_year: 2026, presentation_type: "oral" }),
      ),
    ).toBe("EMNLP 2026 (Oral)");
  });

  it("leaves out what the card does not know yet", () => {
    expect(announcementVenue(paper({ accepted_venue: "EMNLP" }))).toBe("EMNLP");
    expect(announcementVenue(paper({ accepted_year: 2026, presentation_type: "oral" }))).toBe("");
  });
});
