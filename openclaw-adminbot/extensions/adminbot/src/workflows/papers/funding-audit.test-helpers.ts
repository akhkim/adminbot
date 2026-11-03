import type { FundingAuditInput } from "./funding-audit.js";

export const auditNow = Date.parse("2026-11-03T16:00:00Z");
export function fundingInput(): FundingAuditInput {
  return {
    paper: {
      title: "Synthetic Study",
      authors: ["Author A", "Author B"],
      overleafEditUrl: "https://www.overleaf.com/project/synthetic",
      workPeriod: "2026 research period",
    },
    sources: [
      {
        id: "terms",
        kind: "policy",
        location: "private-policy:section-2",
        revision: "v1",
        observedRevision: "v1",
        checkedAt: "2026-11-03T15:00:00Z",
        expiresAt: "2026-11-04T15:00:00Z",
      },
      {
        id: "paper",
        kind: "manuscript",
        location: "private-manuscript:abstract",
        revision: "v3",
        observedRevision: "v3",
        checkedAt: "2026-11-03T15:00:00Z",
        expiresAt: "2026-11-04T15:00:00Z",
      },
    ],
    rules: [
      {
        id: "grant-a",
        label: "Synthetic Grant A",
        kind: "funder",
        sourceId: "terms",
        anyOf: [{ allOf: [{ kind: "topic", key: "causal-methods" }] }],
      },
    ],
    facts: [
      {
        kind: "topic",
        key: "causal-methods",
        value: true,
        sourceId: "paper",
        evidence: "Section 1 establishes a causal-method study.",
      },
    ],
    existingCredits: [
      { id: "other-credit", text: "Coauthor's independent support, verbatim.", scope: "coauthor" },
    ],
  };
}
