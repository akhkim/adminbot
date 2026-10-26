// The impact statement a paper carries, and the quick check that decides whether it must.
//
// Shared by the service and the Control UI so the author's form, the PI's queue and the write
// path all read one answer to "does this paper owe a statement". The classifier is deliberately
// local and deterministic: it reads the lab's own record of the paper (title, alias, venue, notes,
// author roles) and never the manuscript, and nothing here calls a model, so classifying every
// paper on every read sends nothing anywhere.
//
// Three things this is not, kept apart on purpose:
//   - Not publication approval. `pi_approval` stays the only yes to posting; a reviewed statement
//     says the PI read the argument, not that the paper may go out.
//   - Not compute approval or a project verdict. Nothing reads this to allocate or reject.
//   - Not a policy encoding. The term list below finds papers that look safety-related so a human
//     reads them first; a human correction always wins over it.

/** The single slot that stores the statement. */
export const PAPER_IMPACT_SLOT = "impact_statement";

export function isPaperImpactSlot(slot: string): slot is typeof PAPER_IMPACT_SLOT {
  return slot === PAPER_IMPACT_SLOT;
}

/** The five prompts, in the order the form asks them. */
export const paperImpactFields = [
  "risk",
  "intervention",
  "users",
  "assumptions",
  "experiment",
] as const;
export type PaperImpactField = (typeof paperImpactFields)[number];

/**
 * The prompts a statement needs before it counts as written. The other two are asked for and
 * shown to the reviewer, but a statement that names the risk, the mechanism and the user is
 * already one somebody can argue with, and a form that refuses to save until every box is full
 * is a form people stop opening.
 */
export const paperImpactRequiredFields: readonly PaperImpactField[] = [
  "risk",
  "intervention",
  "users",
];

export const paperImpactFieldLabels: Record<PaperImpactField, string> = {
  risk: "What concrete risk or failure mode does this work address?",
  intervention: "How does the work reduce that risk?",
  users: "Who would use the result, and what would they do differently?",
  assumptions: "Which assumptions or uncertainties could break the argument?",
  experiment: "What small experiment would tell us whether to continue?",
};

const FIELD_LIMIT = 4000;
const NOTE_LIMIT = 4000;

export type PaperSafetyVerdict = "related" | "uncertain" | "unrelated";

/** A person's correction to the classifier. Only `related` and `unrelated` settle the question. */
export type PaperImpactSafetyOverride = {
  verdict: "related" | "unrelated";
  by: string;
  at: string;
  reason?: string;
};

export type PaperImpactStatement = Partial<Record<PaperImpactField, string>> & {
  safety?: PaperImpactSafetyOverride;
  reviewed?: boolean;
  review_note?: string;
  reviewed_by?: string;
  reviewed_at?: string;
};

function boundedString(value: unknown, limit: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > limit) {
    return null;
  }
  return value.trim();
}

/** Parse the stored JSON. Null for anything malformed, so a bad row reads as "no statement". */
export function parsePaperImpactStatement(value: string | undefined): PaperImpactStatement | null {
  if (!value) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const raw = data as Record<string, unknown>;
  const out: PaperImpactStatement = {};
  for (const field of paperImpactFields) {
    const text = boundedString(raw[field], FIELD_LIMIT);
    if (text === null) {
      return null;
    }
    if (text) {
      out[field] = text;
    }
  }
  if (raw.reviewed !== undefined) {
    if (typeof raw.reviewed !== "boolean") {
      return null;
    }
    out.reviewed = raw.reviewed;
  }
  for (const key of ["review_note", "reviewed_by", "reviewed_at"] as const) {
    const text = boundedString(raw[key], NOTE_LIMIT);
    if (text === null) {
      return null;
    }
    if (text) {
      out[key] = text;
    }
  }
  if (raw.safety !== undefined && raw.safety !== null) {
    const safety = raw.safety as Record<string, unknown>;
    if (
      typeof safety !== "object" ||
      (safety.verdict !== "related" && safety.verdict !== "unrelated") ||
      typeof safety.by !== "string" ||
      typeof safety.at !== "string"
    ) {
      return null;
    }
    const reason = boundedString(safety.reason, NOTE_LIMIT);
    if (reason === null) {
      return null;
    }
    out.safety = {
      verdict: safety.verdict,
      by: safety.by,
      at: safety.at,
      ...(reason ? { reason } : {}),
    };
  }
  return out;
}

/** Which of the required prompts are still blank. Empty means the statement is written. */
export function paperImpactMissingFields(
  statement: PaperImpactStatement | null,
): PaperImpactField[] {
  return paperImpactRequiredFields.filter((field) => !statement?.[field]);
}

export function hasPaperImpactText(statement: PaperImpactStatement | null): boolean {
  return paperImpactFields.some((field) => Boolean(statement?.[field]));
}

/** Whether two statements say the same thing. Review and override fields do not count. */
export function samePaperImpactText(
  left: PaperImpactStatement | null,
  right: PaperImpactStatement | null,
): boolean {
  return paperImpactFields.every((field) => (left?.[field] ?? "") === (right?.[field] ?? ""));
}

/** The parts of the paper record the classifier reads. Structural so UI and service rows both fit. */
export type PaperSafetyInput = {
  title: string;
  alias?: string;
  venue?: string;
  notes?: string;
  author_roles?: string;
};

// Terms that on their own make a paper look like safety work. Phrases rather than single words
// wherever a word alone is ambiguous: "alignment" is also an image-registration term.
const STRONG_TERMS = [
  "ai safety",
  "safety of ai",
  "llm safety",
  "model safety",
  "ai alignment",
  "value alignment",
  "misalignment",
  "misaligned",
  "jailbreak",
  "red team",
  "red-team",
  "reward hacking",
  "specification gaming",
  "deceptive alignment",
  "scheming",
  "sandbagging",
  "power-seeking",
  "power seeking",
  "corrigib",
  "scalable oversight",
  "dangerous capabilit",
  "catastrophic risk",
  "existential risk",
  "x-risk",
  "prompt injection",
  "backdoor",
  "harmful content",
  "misuse",
  "refusal",
  "guardrail",
  "safeguard",
  "unlearning",
  "mechanistic interpretability",
];

// Terms that often travel with safety work but also with plenty that is not. One is a reason to
// look, not a reason to require.
const WEAK_TERMS = [
  "safety",
  "alignment",
  "interpretability",
  "deception",
  "manipulation",
  "robustness",
  "adversarial",
  "toxicity",
  "bias",
  "fairness",
  "privacy",
  "governance",
  "risk",
  "harm",
  "trustworthy",
  "honesty",
  "sycophancy",
  "hallucination",
  "oversight",
];

function matchTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}`, "i").test(text);
  });
}

export type PaperSafetyClassification = {
  verdict: PaperSafetyVerdict;
  /** The matched terms, so the reader can see why rather than trust a label. */
  reasons: string[];
};

/**
 * The quick check: does this paper look like AI-safety work.
 *
 * Any strong term makes it `related`. Weak terms alone leave it `uncertain`, which is shown as an
 * open question and never makes the statement mandatory -- a guess should not be able to put
 * obligations on somebody. No match at all is `unrelated`. The statement itself is not read: an
 * author who answers the optional prompts should not thereby make them mandatory.
 */
export function classifyPaperSafety(paper: PaperSafetyInput): PaperSafetyClassification {
  const text = [paper.title, paper.alias, paper.venue, paper.notes, paper.author_roles]
    .filter(Boolean)
    .join("\n");
  const strong = matchTerms(text, STRONG_TERMS);
  if (strong.length > 0) {
    return { verdict: "related", reasons: strong };
  }
  const weak = matchTerms(text, WEAK_TERMS);
  if (weak.length > 0) {
    return { verdict: "uncertain", reasons: weak };
  }
  return { verdict: "unrelated", reasons: [] };
}

/**
 * Where a paper's statement stands.
 *
 * - `not_required`: not safety-related; the statement is optional.
 * - `unresolved`: the classifier is unsure and nobody has decided; optional until somebody does.
 * - `missing` / `draft`: required, and not yet written / partly written.
 * - `awaiting_review`: required, written, and not yet read by the PI.
 * - `reviewed`: required, and the PI has marked the current text reviewed.
 */
export type PaperImpactState =
  | "not_required"
  | "unresolved"
  | "missing"
  | "draft"
  | "awaiting_review"
  | "reviewed";

export type PaperImpactStatus = {
  state: PaperImpactState;
  required: boolean;
  verdict: PaperSafetyVerdict;
  source: "classifier" | "override";
  reasons: string[];
  override?: PaperImpactSafetyOverride;
  missing: PaperImpactField[];
  statement: PaperImpactStatement | null;
};

export function paperImpactStatus(
  paper: PaperSafetyInput,
  statement: PaperImpactStatement | null,
): PaperImpactStatus {
  const classified = classifyPaperSafety(paper);
  const override = statement?.safety;
  const verdict = override?.verdict ?? classified.verdict;
  const missing = paperImpactMissingFields(statement);
  const required = verdict === "related";
  const state: PaperImpactState = !required
    ? verdict === "uncertain"
      ? "unresolved"
      : "not_required"
    : !hasPaperImpactText(statement)
      ? "missing"
      : missing.length > 0
        ? "draft"
        : statement?.reviewed
          ? "reviewed"
          : "awaiting_review";
  return {
    state,
    required,
    verdict,
    source: override ? "override" : "classifier",
    reasons: override ? (override.reason ? [override.reason] : []) : classified.reasons,
    ...(override ? { override } : {}),
    missing,
    statement,
  };
}

/** The input the form sends: the prompts, plus the PI's and correctors' fields when they set them. */
export type PaperImpactWriteInput = Partial<Record<PaperImpactField, string>> & {
  /** Omitted keeps the current correction; null removes it. */
  safety?: { verdict: "related" | "unrelated"; reason?: string } | null;
  reviewed?: boolean;
  review_note?: string;
};

export type PaperImpactMergeResult =
  | { ok: true; statement: PaperImpactStatement }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Fold one write into the stored statement, enforcing who may change what.
 *
 * Authors edit the prompts. Only the head professor marks a statement reviewed or writes the
 * review note. Only the head professor or an admin corrects the classifier. Fields a writer may
 * not touch are carried over from the stored row rather than taken from the request, so an
 * author's autosave cannot quietly drop the PI's review or a correction.
 *
 * Changing the text of a reviewed statement re-opens it: the review was of the argument that was
 * there, not the one that replaced it. The old note stays so the PI can see what they said.
 */
export function mergePaperImpactWrite(params: {
  existing: PaperImpactStatement | null;
  valueText: string | undefined;
  memberId: string;
  isHeadProfessor: boolean;
  privileged: boolean;
  now: string;
}): PaperImpactMergeResult {
  const raw = (params.valueText ?? "").trim();
  let input: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      input = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, status: 400, error: "The impact statement must be a JSON object." };
    }
  }
  const existing = params.existing;
  const next: PaperImpactStatement = {};
  for (const field of paperImpactFields) {
    const text = boundedString(input[field], FIELD_LIMIT);
    if (text === null) {
      return {
        ok: false,
        status: 400,
        error: `Each impact prompt is text of at most ${FIELD_LIMIT} characters.`,
      };
    }
    if (text) {
      next[field] = text;
    }
  }

  const reviewRequested = input.reviewed !== undefined || input.review_note !== undefined;
  if (reviewRequested && !params.isHeadProfessor) {
    const sameReview =
      (input.reviewed === undefined || input.reviewed === existing?.reviewed) &&
      (input.review_note === undefined || input.review_note === (existing?.review_note ?? ""));
    if (!sameReview) {
      return {
        ok: false,
        status: 403,
        error: "Only the head professor can review an impact statement.",
      };
    }
  }
  if (input.reviewed !== undefined && typeof input.reviewed !== "boolean") {
    return { ok: false, status: 400, error: "reviewed must be true or false." };
  }
  const note = boundedString(input.review_note, NOTE_LIMIT);
  if (note === null) {
    return { ok: false, status: 400, error: "The review note is too long." };
  }

  const textChanged = !samePaperImpactText(existing, next);
  if (params.isHeadProfessor && input.reviewed !== undefined) {
    if (input.reviewed) {
      next.reviewed = true;
      next.reviewed_by = params.memberId;
      next.reviewed_at = params.now;
    }
    const reviewNote = note ?? existing?.review_note;
    if (reviewNote) {
      next.review_note = reviewNote;
    }
  } else {
    // Carry the review over, unless the argument it was about has changed.
    if (existing?.reviewed && !textChanged) {
      next.reviewed = true;
      if (existing.reviewed_by) {
        next.reviewed_by = existing.reviewed_by;
      }
      if (existing.reviewed_at) {
        next.reviewed_at = existing.reviewed_at;
      }
    }
    const reviewNote = params.isHeadProfessor && note !== undefined ? note : existing?.review_note;
    if (reviewNote) {
      next.review_note = reviewNote;
    }
  }

  if (input.safety !== undefined) {
    const requested = input.safety as Record<string, unknown> | null;
    const sameOverride =
      requested === null
        ? !existing?.safety
        : requested?.verdict === existing?.safety?.verdict &&
          (requested?.reason ?? "") === (existing?.safety?.reason ?? "");
    if (!sameOverride && !(params.isHeadProfessor || params.privileged)) {
      return {
        ok: false,
        status: 403,
        error: "Only the head professor or an admin can correct the safety classification.",
      };
    }
    if (requested === null) {
      // Cleared: the classifier's answer stands again.
    } else if (
      typeof requested !== "object" ||
      (requested.verdict !== "related" && requested.verdict !== "unrelated")
    ) {
      return { ok: false, status: 400, error: "A correction is either related or unrelated." };
    } else if (sameOverride && existing?.safety) {
      next.safety = existing.safety;
    } else {
      const reason = boundedString(requested.reason, NOTE_LIMIT);
      if (reason === null) {
        return { ok: false, status: 400, error: "The correction reason is too long." };
      }
      next.safety = {
        verdict: requested.verdict,
        by: params.memberId,
        at: params.now,
        ...(reason ? { reason } : {}),
      };
    }
  } else if (existing?.safety) {
    next.safety = existing.safety;
  }
  return { ok: true, statement: next };
}

/** Whether a statement carries anything worth storing at all. */
export function isEmptyPaperImpactStatement(statement: PaperImpactStatement): boolean {
  return !hasPaperImpactText(statement) && !statement.safety && !statement.review_note;
}

/**
 * Why the PI's yes to publication must wait, or null.
 *
 * The one transition a missing statement blocks. Chosen because it is already a human decision
 * the head professor makes paper by paper, so the block lands on the person who can resolve it --
 * by reading the statement once it is written, or by correcting the classification -- and never
 * stalls the authors' own steps. Uncertain papers are not blocked.
 */
export function paperImpactApprovalBlock(status: PaperImpactStatus): string | null {
  if (!status.required || status.state === "awaiting_review" || status.state === "reviewed") {
    return null;
  }
  return "This paper looks AI-safety related, so its impact statement must be written before publication can be approved. Ask the authors to finish it, or correct the classification.";
}
