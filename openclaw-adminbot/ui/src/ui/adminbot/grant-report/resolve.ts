// Turns the live paper store into classified rows, so the report tracks the database instead of a
// file somebody has to remember to edit.
//
// Three tiers, because placing a paper on the safety taxonomy is a judgment call and pretending
// otherwise would put invented claims in a grant application:
//
//   curated      -- a human placed this paper (papers.ts). Authoritative.
//   inferred     -- no curated entry, so the keyword rules below guessed from title and venue.
//                   Shown as a guess everywhere it appears, and listed for confirmation.
//   unclassified -- nothing matched. Listed for triage rather than dropped.
//
// A newly added paper therefore appears on the report the moment it lands in the store: in the
// right area if the rules recognise it, in the triage list if they do not. Neither outcome is
// silent, which is the property that matters -- a grant report that quietly omits a paper is worse
// than one that says it does not know where it goes.
//
// The live store and the sheet snapshot are unioned, not swapped. Papers sit on the sheet before
// anyone opens a PaperPublish record for them, and a report that shrank when the tab went live
// would have been a regression dressed up as an improvement. A snapshot row disappears as soon as
// the store carries a paper with the same title.

import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import type { SafetyAreaId } from "./areas.ts";
import { GRANT_PAPERS, type GrantPaper } from "./papers.ts";

export type ClassificationOrigin = "curated" | "inferred" | "unclassified";

export type ClassifiedPaper = {
  id: string;
  title: string;
  venue: string;
  authors: string;
  topic?: string;
  areas: readonly SafetyAreaId[];
  sections: readonly string[];
  origin: ClassificationOrigin;
  /** True when the row came from the bundled sheet snapshot rather than the live store. */
  fromSnapshot: boolean;
  /** Set for prior results the proposal cites; these are not part of the current cycle. */
  published?: boolean;
  link?: string;
  alsoListedAs?: string;
};

/**
 * Title reduced to something two spellings of the same paper agree on.
 *
 * The sheet and the paper record are typed by different people at different times, so they differ
 * in case, punctuation and the trailing venue note. Everything that is not a letter or a digit goes.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

const CURATED_BY_TITLE = new Map<string, GrantPaper>(
  GRANT_PAPERS.map((paper) => [titleKey(paper.title), paper]),
);

/**
 * Keyword rules, applied to title and venue together. Every rule that matches contributes, so a
 * paper about interpretability of deception picks up both placements rather than the first one.
 *
 * Deliberately generous: an inferred placement is labelled as a guess wherever it renders, so the
 * cost of a wrong guess is a visible row to correct, while the cost of no guess is a paper nobody
 * notices is missing. Order does not matter -- the result is a union.
 */
const RULES: readonly {
  test: RegExp;
  areas: readonly SafetyAreaId[];
  sections: readonly string[];
}[] = [
  {
    test: /interp|probe|circuit|transcoder|steering|attribution|mechanistic|representation|activation|sparse autoencoder|\bsae\b|latent|neuron/u,
    areas: ["whiteBox"],
    sections: ["p1.1.5"],
  },
  {
    test: /eval hacking|contamination|reward hack|benchmark validity|data attribution|influence function/u,
    areas: ["evals"],
    sections: ["p1.1.1", "p1.1.1.A"],
  },
  {
    test: /eval awareness|evaluation awareness|situational awareness|sandbag/u,
    areas: ["evals"],
    sections: ["p1.1.1.B"],
  },
  {
    test: /judge|grader|scalable oversight|llm-as-a-judge/u,
    areas: ["evals"],
    sections: ["p1.1.1.C"],
  },
  {
    test: /misalign|deception|deceptive|sycophan|alignment faking|scheming|lie|lying|harmbench|propensity/u,
    areas: ["evals"],
    sections: ["p1.1.2"],
  },
  {
    test: /adversarial|robust|jailbreak|prompt injection|tamper|unlearn|defen[cs]e|erasure|harmful|safeguard|honeypot/u,
    areas: ["alignment", "construction"],
    sections: ["p1.1.3"],
  },
  {
    test: /causal|generali[sz]ation|fine-?tun|forget|training dynamics|curriculum|distribution shift|entangle|grokking/u,
    areas: ["construction"],
    sections: ["p1.1.4"],
  },
  {
    test: /power concentration|autocrat|democra|election|governance|political|revisionism|deliberation|pluralistic/u,
    areas: ["evals"],
    sections: ["p1.2.1"],
  },
  { test: /coup/u, areas: ["evals"], sections: ["p1.2.2"] },
  {
    test: /eu ai act|code of practice|regulat|legal|compliance/u,
    areas: ["evals"],
    sections: ["p1.2.4"],
  },
  {
    test: /multi-?agent|agentic social|debate|social dilemma|negotiat|collusion/u,
    areas: ["evals"],
    sections: ["p1.3.1"],
  },
  {
    test: /game theor|cooperation|incomplete contract|mechanism design|sanction|institutional|prosocial|moral agent/u,
    areas: ["construction", "alignment"],
    sections: ["p1.3.2"],
  },
  {
    test: /monitor|sandbox|permission|control eval|irreversib|chain-of-thought monitor/u,
    areas: ["control"],
    sections: [],
  },
  {
    test: /weak-to-strong|automated audit|auto-?interp|ai scientist|self-improv/u,
    areas: ["aiSolve"],
    sections: [],
  },
];

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** What the rules make of a paper the curated table does not name. */
export function inferPlacement(
  title: string,
  venue: string,
): {
  areas: SafetyAreaId[];
  sections: string[];
} {
  const haystack = `${title} ${venue}`.toLowerCase();
  const areas: SafetyAreaId[] = [];
  const sections: string[] = [];
  for (const rule of RULES) {
    if (rule.test.test(haystack)) {
      areas.push(...rule.areas);
      sections.push(...rule.sections);
    }
  }
  return { areas: unique(areas), sections: unique(sections) };
}

function venueOf(record: AdminBotPaperRecord): string {
  return record.accepted_venue || record.venue || "";
}

/** One live paper record, placed on both maps. */
export function classifyRecord(record: AdminBotPaperRecord): ClassifiedPaper {
  const curated = CURATED_BY_TITLE.get(titleKey(record.title));
  const base = {
    id: record.id,
    title: record.title,
    // The store's venue is the live answer and the sheet's is a note from whenever it was typed,
    // so the store wins on a paper both know about.
    venue: venueOf(record) || curated?.venue || "",
    authors: record.authors.join(", ") || curated?.authors || "",
    fromSnapshot: false,
  };
  if (curated) {
    return {
      ...base,
      topic: curated.topic,
      areas: curated.areas,
      sections: curated.sections,
      origin: "curated",
      link: curated.link,
      alsoListedAs: curated.alsoListedAs,
    };
  }
  const inferred = inferPlacement(record.title, base.venue);
  const matched = inferred.areas.length > 0 || inferred.sections.length > 0;
  return {
    ...base,
    areas: inferred.areas,
    sections: inferred.sections,
    origin: matched ? "inferred" : "unclassified",
  };
}

function fromSnapshot(paper: GrantPaper): ClassifiedPaper {
  return {
    id: paper.id,
    title: paper.title,
    venue: paper.venue,
    authors: paper.authors,
    topic: paper.topic,
    areas: paper.areas,
    sections: paper.sections,
    origin: "curated",
    fromSnapshot: true,
    published: paper.published,
    link: paper.link,
    alsoListedAs: paper.alsoListedAs,
  };
}

/**
 * The report's rows: every live paper, plus the snapshot papers the store has not caught up with.
 *
 * Published prior work the proposal cites is always carried from the snapshot -- those papers are
 * years old and were never going to have a PaperPublish record, but leaving them out would
 * understate the adversarial-defense track record by four peer-reviewed results.
 */
export function resolvePapers(
  records: readonly AdminBotPaperRecord[] = [],
): readonly ClassifiedPaper[] {
  const live = records.map((record) => classifyRecord(record));
  const seen = new Set(live.map((paper) => titleKey(paper.title)));
  const carried = GRANT_PAPERS.filter(
    (paper) => paper.published || !seen.has(titleKey(paper.title)),
  ).map((paper) => fromSnapshot(paper));
  return [...live, ...carried];
}

/** Rows a human still has to place: the guesses, then the ones nothing matched. */
export function needsReview(papers: readonly ClassifiedPaper[]): readonly ClassifiedPaper[] {
  return papers.filter((paper) => paper.origin !== "curated");
}
