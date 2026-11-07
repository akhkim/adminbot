import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditFunding } from "./funding-audit.js";
import { auditNow, fundingInput } from "./funding-audit.test-helpers.js";
import { assertOverleafPayloadReady, buildOverleafEditPayload } from "./overleaf-editing.js";

describe("source-backed funding audit", () => {
  it("preserves source-confirmed outside coauthor funding absent from the local policy", () => {
    const input = fundingInput();
    input.existingCredits[0] = {
      id: "outside-funder",
      text: "Coauthor's independent foundation support.",
      scope: "coauthor",
      sourceId: "coauthor",
      evidence: "Coauthor confirms support belongs to their research contribution.",
    };
    input.sources.push({
      ...input.sources[1],
      id: "coauthor",
      kind: "author_confirmation",
      location: "private-author-confirmation:record-1",
    });
    input.facts[0].value = false;
    const audit = auditFunding(input);
    expect(audit.findings[0].decision).toBe("exclude");
    expect(audit.preservedCredits).toEqual(input.existingCredits);
    expect(audit.preservedCredits[0].sourceId).toBe("coauthor");
  });
  it("keeps explicit paper-period negative affiliation independent of current roster", () => {
    const input = fundingInput();
    input.rules[0].anyOf = [
      { allOf: [{ kind: "affiliation", key: "Institute Z", author: "Author A" }] },
    ];
    input.facts = [
      {
        kind: "affiliation",
        key: "Institute Z",
        author: "Author A",
        value: false,
        sourceId: "paper",
        evidence: "Author confirms this affiliation did not apply during this work.",
      },
    ];
    expect(auditFunding(input).findings[0].decision).toBe("exclude");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(auditNow);
  });
  afterEach(() => vi.useRealTimers());
  it.each([true, false, undefined])(
    "distinguishes explicitly met/not met/missing evidence: %s",
    (value) => {
      const input = fundingInput();
      if (value === undefined) {
        input.facts = [];
      } else {
        input.facts[0].value = value;
      }
      const audit = auditFunding(input);
      expect(audit.findings[0].decision).toBe(
        value === undefined ? "unknown" : value ? "include" : "exclude",
      );
      expect(audit.preservedCredits).toEqual(input.existingCredits);
    },
  );
  it.each(["missing", "changed", "expired", "future", "invalid"])(
    "leaves %s policy source unresolved",
    (state) => {
      const input = fundingInput();
      if (state === "missing") {
        input.sources.shift();
      }
      if (state === "changed") {
        input.sources[0].observedRevision = "v2";
      }
      if (state === "expired") {
        input.sources[0].expiresAt = "2026-11-03T15:30:00Z";
      }
      if (state === "future") {
        input.sources[0].checkedAt = "2099-01-01";
      }
      if (state === "invalid") {
        input.sources[0].expiresAt = "not a date";
      }
      expect(auditFunding(input).findings[0].decision).toBe("unknown");
    },
  );
  it("uses independent affiliations and topic OR/AND without combining institutions", () => {
    const input = fundingInput();
    input.rules[0].anyOf = [
      {
        allOf: [
          { kind: "affiliation", key: "Institute A", author: "Author A" },
          { kind: "topic", key: "causal-methods" },
        ],
      },
      { allOf: [{ kind: "affiliation", key: "Institute B", author: "Author A" }] },
    ];
    input.facts.push({
      kind: "affiliation",
      key: "Institute A",
      author: "Author A",
      value: true,
      sourceId: "paper",
      evidence: "Paper work-period author block.",
    });
    expect(auditFunding(input).findings[0].decision).toBe("include");
    input.facts[0].value = false;
    expect(auditFunding(input).findings[0].decision).toBe("unknown");
    input.facts.push({
      kind: "affiliation",
      key: "Institute B",
      author: "Author A",
      value: false,
      sourceId: "paper",
      evidence: "Author explicitly confirms no B affiliation for this work.",
    });
    expect(auditFunding(input).findings[0].decision).toBe("exclude");
  });
  it("does not infer multi-agent from multi-turn, general safety, membership or email", () => {
    const input = fundingInput();
    input.rules[0].anyOf = [{ allOf: [{ kind: "topic", key: "multi-agent" }] }];
    input.facts = ["multi-turn", "ai-safety"].map((key) => ({
      kind: "topic",
      key,
      value: true,
      sourceId: "paper",
      evidence: "Paper explicitly studies only these topics.",
    }));
    expect(auditFunding(input).findings[0].decision).toBe("unknown");
    expect(() =>
      auditFunding({ ...input, facts: [{ ...input.facts[0], kind: "membership" }] }),
    ).toThrow("Invalid funding");
  });
  it.each(["resource", "tool"] as const)(
    "requires actual %s usage in every alternative",
    (kind) => {
      const input = fundingInput();
      input.rules[0].kind = kind;
      expect(auditFunding(input).findings[0].decision).toBe("unknown");
      const usage = {
        kind: kind === "tool" ? ("tool_used" as const) : ("resource_used" as const),
        key: "grant-a",
      };
      input.rules[0].anyOf = [{ allOf: [usage] }];
      input.facts = [
        {
          ...usage,
          value: true,
          sourceId: "paper",
          evidence: "Topic mentions the resource, no usage receipt.",
        },
      ];
      expect(auditFunding(input).findings[0].decision).toBe("unknown");
      input.sources[1].kind = "usage_receipt";
      expect(auditFunding(input).findings[0].decision).toBe("include");
      input.facts[0].value = false;
      expect(auditFunding(input).findings[0].decision).toBe("exclude");
      input.rules[0].anyOf.push({ allOf: [{ kind: "topic", key: "causal-methods" }] });
      expect(auditFunding(input).findings[0].decision).toBe("unknown");
    },
  );
  it("does not choose between conflicting or stale fact evidence", () => {
    const input = fundingInput();
    input.facts.push({ ...input.facts[0], value: false });
    expect(auditFunding(input).findings[0].decision).toBe("unknown");
    input.facts.pop();
    input.sources[1].observedRevision = "new";
    expect(auditFunding(input).findings[0].decision).toBe("unknown");
  });
  it("rejects executable predicates, duplicate sources and invalid author scopes", () => {
    const input = fundingInput();
    expect(() =>
      auditFunding({ ...input, rules: [{ ...input.rules[0], run: "return true" }] }),
    ).toThrow("Invalid");
    expect(() => auditFunding({ ...input, sources: [...input.sources, input.sources[0]] })).toThrow(
      "unique",
    );
    input.rules[0].anyOf = [
      { allOf: [{ kind: "affiliation", key: "Institute", author: "Someone Else" }] },
    ];
    expect(auditFunding(input).findings[0].decision).toBe("unknown");
  });
  it("leaves identical author entries unresolved rather than attaching affiliation to the wrong person", () => {
    const input = fundingInput();
    input.paper.authors = ["Shared Name", "Shared Name"];
    input.rules[0].anyOf = [
      { allOf: [{ kind: "affiliation", key: "Institute A", author: "Shared Name" }] },
    ];
    input.facts = [
      {
        kind: "affiliation",
        key: "Institute A",
        author: "Shared Name",
        value: true,
        sourceId: "paper",
        evidence: "Only one of these authors is affiliated.",
      },
    ];
    expect(auditFunding(input).findings[0].decision).toBe("unknown");
  });
  it("refuses forged findings, erased credits and missing funding input before execution", () => {
    const input = fundingInput();
    const payload = buildOverleafEditPayload({
      ...input.paper,
      fundingAudit: input,
      mode: "funding_check",
      requestedEdits: "Review credits.",
      members: [],
    });
    const forged = structuredClone(payload);
    forged.fundingAudit!.findings[0].decision = "exclude";
    expect(() => assertOverleafPayloadReady(forged)).toThrow("changed");
    const erased = structuredClone(payload);
    erased.fundingAudit!.preservedCredits = [];
    expect(() => assertOverleafPayloadReady(erased)).toThrow("changed");
    expect(() => assertOverleafPayloadReady({ ...payload, fundingAudit: undefined })).toThrow(
      "requires source-backed",
    );
  });
  it("binds findings to exact paper/authors and rechecks expiry before execution", () => {
    const input = fundingInput();
    const payload = buildOverleafEditPayload({
      ...input.paper,
      fundingAudit: input,
      mode: "funding_check",
      requestedEdits: "Review only candidate credits, preserve other authors and support.",
      members: [],
    });
    expect(payload.fundingAudit?.preservedCredits).toEqual(input.existingCredits);
    expect(() => assertOverleafPayloadReady(payload)).not.toThrow();
    expect(() =>
      buildOverleafEditPayload({
        ...input.paper,
        title: "Other",
        fundingAudit: input,
        requestedEdits: "edit",
        members: [],
      }),
    ).toThrow("exact paper");
    expect(() =>
      assertOverleafPayloadReady({
        ...payload,
        paper: { ...payload.paper, authors: input.paper.authors.toReversed() },
      }),
    ).toThrow("exact paper");
    vi.setSystemTime(Date.parse("2026-11-05T00:00:00Z"));
    expect(() => assertOverleafPayloadReady(payload)).toThrow("changed");
  });
});
