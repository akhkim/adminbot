import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const text = Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" });
const kind = Type.Union([
  Type.Literal("topic"),
  Type.Literal("affiliation"),
  Type.Literal("resource_used"),
  Type.Literal("tool_used"),
]);
const predicate = Type.Object(
  {
    kind,
    key: text,
    author: Type.Optional(text),
  },
  { additionalProperties: false },
);

/** Private, reviewed input, never a universal grant list. Conditions are bounded DNF, not code. */
export const fundingAuditInputSchema = Type.Object(
  {
    paper: Type.Object(
      {
        title: text,
        authors: Type.Array(text, { minItems: 1, maxItems: 200 }),
        overleafEditUrl: text,
        workPeriod: text,
      },
      { additionalProperties: false },
    ),
    sources: Type.Array(
      Type.Object(
        {
          id: text,
          kind: Type.Union([
            Type.Literal("policy"),
            Type.Literal("manuscript"),
            Type.Literal("author_confirmation"),
            Type.Literal("usage_receipt"),
          ]),
          location: text,
          revision: text,
          observedRevision: text,
          checkedAt: text,
          expiresAt: text,
        },
        { additionalProperties: false },
      ),
      { maxItems: 200 },
    ),
    rules: Type.Array(
      Type.Object(
        {
          id: text,
          label: text,
          kind: Type.Union([
            Type.Literal("funder"),
            Type.Literal("resource"),
            Type.Literal("tool"),
          ]),
          sourceId: text,
          anyOf: Type.Array(
            Type.Object(
              {
                allOf: Type.Array(predicate, { minItems: 1, maxItems: 20 }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 20 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    facts: Type.Array(
      Type.Object(
        {
          ...predicate.properties,
          value: Type.Boolean(),
          sourceId: text,
          evidence: text,
        },
        { additionalProperties: false },
      ),
      { maxItems: 500 },
    ),
    existingCredits: Type.Array(
      Type.Object(
        {
          id: text,
          text,
          scope: Type.Union([Type.Literal("policy"), Type.Literal("coauthor")]),
          sourceId: Type.Optional(text),
          evidence: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
      { maxItems: 200 },
    ),
  },
  { additionalProperties: false },
);

export type FundingAuditInput = Static<typeof fundingAuditInputSchema>;
type Predicate = Static<typeof predicate>;
export type FundingFinding = {
  id: string;
  label: string;
  kind: "funder" | "resource" | "tool";
  decision: "include" | "exclude" | "unknown";
  reason: string;
  sourceId: string;
  evidence: string[];
};
export type FundingAudit = {
  input: FundingAuditInput;
  findings: FundingFinding[];
  /** Remain in the original order, including excluded candidates pending exact edit review. */
  preservedCredits: FundingAuditInput["existingCredits"];
};
type Evaluation = { value: boolean | undefined; reasons: string[]; evidence: string[] };

export function auditFunding(raw: unknown, now = Date.now()): FundingAudit {
  if (!Value.Check(fundingAuditInputSchema, raw)) {
    throw new Error(
      "Invalid funding audit input; use the declared paper, sources, rules and facts schema.",
    );
  }
  const input = raw as FundingAuditInput;
  for (const entries of [input.sources, input.rules]) {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error("Funding audit source and rule IDs must be unique.");
    }
  }
  function sourceIssue(id: string): string | undefined {
    const source = input.sources.find((entry) => entry.id === id);
    if (!source) {
      return `Missing source ${id}`;
    }
    if (source.revision !== source.observedRevision) {
      return `Changed source ${id}; refresh conditions/evidence`;
    }
    const checked = Date.parse(source.checkedAt);
    const expires = Date.parse(source.expiresAt);
    if (
      !Number.isFinite(checked) ||
      !Number.isFinite(expires) ||
      checked > now ||
      expires <= now ||
      expires <= checked
    ) {
      return `Stale or invalid source freshness ${id}`;
    }
    return undefined;
  }
  function evaluate(p: Predicate): Evaluation {
    if (
      (p.kind === "affiliation" &&
        (!p.author || input.paper.authors.filter((author) => author === p.author).length !== 1)) ||
      (p.kind !== "affiliation" && p.author !== undefined)
    ) {
      return {
        value: undefined,
        reasons: [`Invalid paper author scope for ${p.kind}:${p.key}`],
        evidence: [],
      };
    }
    const facts = input.facts.filter(
      (fact) => fact.kind === p.kind && fact.key === p.key && fact.author === p.author,
    );
    if (!facts.length) {
      return {
        value: undefined,
        reasons: [`No explicit evidence for ${p.kind}:${p.key}`],
        evidence: [],
      };
    }
    const issues = facts
      .map((fact) => {
        const issue = sourceIssue(fact.sourceId);
        const source = input.sources.find((entry) => entry.id === fact.sourceId);
        const allowed =
          p.kind === "topic" || p.kind === "affiliation"
            ? ["manuscript", "author_confirmation"]
            : ["usage_receipt", "author_confirmation"];
        return (
          issue ??
          (!source || !allowed.includes(source.kind)
            ? `Source ${fact.sourceId} cannot establish ${p.kind}`
            : undefined)
        );
      })
      .filter((issue): issue is string => Boolean(issue));
    const evidence = facts.map((fact) => `${fact.sourceId}: ${fact.evidence}`);
    if (issues.length || new Set(facts.map((fact) => fact.value)).size !== 1) {
      return {
        value: undefined,
        reasons: issues.length ? issues : [`Conflicting facts for ${p.kind}:${p.key}`],
        evidence,
      };
    }
    return {
      value: facts[0].value,
      reasons: [`${p.kind}:${p.key} explicitly ${facts[0].value ? "met" : "not met"}`],
      evidence,
    };
  }
  function combine(values: Evaluation[], all: boolean): Evaluation {
    const decisive = values.some((entry) => entry.value === !all);
    return {
      value: decisive ? !all : values.some((entry) => entry.value === undefined) ? undefined : all,
      reasons: values.flatMap((entry) => entry.reasons),
      evidence: values.flatMap((entry) => entry.evidence),
    };
  }
  const findings = input.rules.map((rule): FundingFinding => {
    const policySource = input.sources.find((source) => source.id === rule.sourceId);
    const issue =
      sourceIssue(rule.sourceId) ??
      (policySource?.kind !== "policy" ? "Rule requires a policy source" : undefined);
    // A topical match cannot establish actual resource/tool use, even in an OR branch.
    const requiredUsage =
      rule.kind === "resource" ? "resource_used" : rule.kind === "tool" ? "tool_used" : undefined;
    const missingUsage =
      requiredUsage &&
      rule.anyOf.some(
        (clause) => !clause.allOf.some((p) => p.kind === requiredUsage && p.key === rule.id),
      );
    const evaluated = combine(
      rule.anyOf.map((clause) => combine(clause.allOf.map(evaluate), true)),
      false,
    );
    return {
      id: rule.id,
      label: rule.label,
      kind: rule.kind,
      sourceId: rule.sourceId,
      decision:
        issue || missingUsage || evaluated.value === undefined
          ? "unknown"
          : evaluated.value
            ? "include"
            : "exclude",
      reason:
        issue ??
        (missingUsage
          ? "Every alternative must require explicit actual use of this resource/tool"
          : evaluated.reasons.join("; ")),
      evidence: [...new Set(evaluated.evidence)],
    };
  });
  return { input, findings, preservedCredits: input.existingCredits };
}

export function assertFundingAuditReady(
  raw: FundingAudit,
  paper: { title: string; authors: string[]; overleafEditUrl: string },
): void {
  const audit = auditFunding(raw?.input);
  if (
    audit.input.paper.title !== paper.title ||
    audit.input.paper.overleafEditUrl !== paper.overleafEditUrl ||
    JSON.stringify(audit.input.paper.authors) !== JSON.stringify(paper.authors)
  ) {
    throw new Error("Funding audit must match this exact paper and original author order.");
  }
  if (
    JSON.stringify(audit.findings) !== JSON.stringify(raw.findings) ||
    JSON.stringify(audit.preservedCredits) !== JSON.stringify(raw.preservedCredits)
  ) {
    throw new Error("Funding audit changed; regenerate and review a new immutable proposal.");
  }
  if (audit.findings.some((finding) => finding.decision === "unknown")) {
    throw new Error(
      "Funding audit has unknown conditions; obtain paper-specific evidence before editing acknowledgements.",
    );
  }
}
