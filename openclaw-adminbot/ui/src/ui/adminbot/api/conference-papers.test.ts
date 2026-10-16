import { describe, expect, it } from "vitest";
import { withWorkshopRunDefaults } from "./conference-papers.ts";

const workshop = {
  workshop_id: "ws-1",
  name: "Safety Workshop",
  parent_conference: "NeurIPS 2035",
  conference_location: "Test City",
  archival_status: "non_archival",
  cross_submission_status: "allowed",
  cross_submission_evidence: "allowed in the call",
  cross_submission_source_url: "https://example.test/ws-1",
  profile_extracted_at: "2035-01-01T00:00:00Z",
  routes: [],
};

describe("withWorkshopRunDefaults", () => {
  it("puts each pair's workshop profile back from the shared map", () => {
    const pair = { workshop_id: "ws-1", topic_relevance: 0.9, paper: { paper_id: "p1" } };
    const run = withWorkshopRunDefaults({
      status: "ready",
      preview: {
        workshops: { "ws-1": workshop },
        recipients: [{ recipient_member_id: "m1", recommendations: [pair], draft: null }],
        unresolved_recipients: [{ paper: { paper_id: "p2" }, recommendations: [pair] }],
      },
    }) as {
      calls_failed: number;
      preview: {
        workshops?: unknown;
        recipients: Array<{ recommendations: Array<{ workshop: unknown }> }>;
        unresolved_recipients: Array<{ recommendations: Array<{ workshop: unknown }> }>;
      };
    };
    expect(run.calls_failed).toBe(0);
    expect(run.preview.workshops).toBeUndefined();
    expect(run.preview.recipients[0]?.recommendations[0]?.workshop).toEqual(workshop);
    expect(run.preview.unresolved_recipients[0]?.recommendations[0]?.workshop).toEqual(workshop);
  });

  it("leaves an older service's nested profiles alone", () => {
    const preview = {
      recipients: [{ recipient_member_id: "m1", recommendations: [{ workshop }], draft: null }],
      unresolved_recipients: [],
    };
    const run = withWorkshopRunDefaults({ status: "ready", calls_failed: 2, preview }) as {
      calls_failed: number;
      preview: unknown;
    };
    expect(run.calls_failed).toBe(2);
    expect(run.preview).toBe(preview);
  });
});
