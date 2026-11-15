import { describe, expect, it } from "vitest";
import type { OpenReviewCitationCheck } from "../../contracts/openreview-citation-checks.js";
import { summarizeOpenReviewCitationChecks } from "./openreview-citation-summary.js";

const check = (
  submission_id: string,
  pdf_path: string,
  overrides: Partial<OpenReviewCitationCheck> = {},
): OpenReviewCitationCheck => ({
  submission_id,
  pdf_path,
  title: `Synthetic ${submission_id}`,
  venue_id: "Synthetic.cc/2027/Conference",
  status: "completed",
  checked_at: "2027-01-02T00:00:00.000Z",
  attempts: 1,
  ...overrides,
});

describe("summarizeOpenReviewCitationChecks", () => {
  it("keeps the latest version per submission with only the references to look at", () => {
    const summaries = summarizeOpenReviewCitationChecks([
      check("paperA", "/pdf/v2.pdf", {
        findings: [
          {
            citation: "Matched ref",
            status: "matched",
            explanation: "Found.",
            source: "crossref",
            title: "Matched ref",
            url: "https://example.test/matched",
          },
          {
            citation: "Odd ref",
            status: "review",
            explanation: "Year differs.",
            source: "crossref",
            url: "https://example.test/odd",
          },
          { citation: "Missing ref", status: "not_found", explanation: "No record." },
          { citation: "Unchecked ref", status: "unavailable", explanation: "Database down." },
        ],
      }),
      check("paperB", "/pdf/b1.pdf", { status: "failed", error: "download failed" }),
      check("paperA", "/pdf/v1.pdf", {
        checked_at: "2027-01-01T00:00:00.000Z",
        findings: [{ citation: "Old ref", status: "not_found", explanation: "No record." }],
      }),
    ]);
    expect(summaries).toEqual([
      {
        ...check("paperA", "/pdf/v2.pdf"),
        findings: [
          { citation: "Odd ref", status: "review", explanation: "Year differs." },
          { citation: "Missing ref", status: "not_found", explanation: "No record." },
        ],
        finding_count: 4,
        version_count: 2,
      },
      {
        ...check("paperB", "/pdf/b1.pdf", { status: "failed", error: "download failed" }),
        finding_count: 0,
        version_count: 1,
      },
    ]);
  });
});
