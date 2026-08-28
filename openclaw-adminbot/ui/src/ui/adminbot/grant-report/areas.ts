// Bundled snapshot for the Grant Report tab: the lab's paper pipeline placed on two maps at once.
//
// Map one is the field taxonomy from the Shallow Review of Technical AI Safety 2025 (Leech et al.,
// shallowreview.ai) -- six areas that a funder already has a mental model for. Map two is the
// section tree of the EuroSafeAI 2-year proposal, whose leaves each need a "track record" block in
// the shape Part 2.3 already uses for the workshop item.
//
// Snapshot, not a live read. The papers come from the `papers` tab of "Jinesis Contact/Paper list
// with Zhijing"; that sheet is a working document edited hourly during a submission sprint, and a
// grant report wants a citable state of the world rather than whatever the sheet said when the page
// happened to load. Re-run the mapping and edit this file when the report is next compiled -- the
// `SOURCE` constants below record what it was compiled from.
//
// A paper carrying no `sections` is deliberate, not missing data: it is lab output that no part of
// the technical agenda claims, and the coverage panel counts it so the gap is visible.

export const SOURCE = {
  sheet: {
    title: "Jinesis Contact/Paper list with Zhijing",
    tab: "papers",
    url: "https://docs.google.com/spreadsheets/d/1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68/edit",
  },
  proposal: {
    title: "2-Year Research Proposal to Support the Early Growth of EuroSafeAI",
    url: "https://docs.google.com/document/d/1cELZ8xnBxXd6091qRVfvsdbLWSuTWumAEpAS-njY1O0/edit",
  },
  taxonomy: {
    title: "Shallow Review of Technical AI Safety 2025",
    attribution: "Leech et al.",
    url: "https://www.shallowreview.ai/",
  },
  compiledOn: "2026-08-27",
} as const;

// ---------------------------------------------------------------------------
// Map one: the six areas.
// ---------------------------------------------------------------------------

export const SAFETY_AREA_IDS = [
  "alignment",
  "control",
  "whiteBox",
  "evals",
  "construction",
  "aiSolve",
] as const;

export type SafetyAreaId = (typeof SAFETY_AREA_IDS)[number];

export type SafetyArea = {
  id: SafetyAreaId;
  name: string;
  /** The one-line gloss the review gives each area, kept verbatim. */
  gloss: string;
  /** The techniques the review lists under the area, kept verbatim and in its order. */
  techniques: readonly string[];
};

export const SAFETY_AREAS: readonly SafetyArea[] = [
  {
    id: "alignment",
    name: "Alignment",
    gloss: "make it want the right thing",
    techniques: [
      "RLHF",
      "Constitutional AI / RLAIF",
      "deliberative alignment",
      "character training",
      "model specs and constitutions",
      "debate",
      "task decomposition",
      "recursive reward modelling",
      "ELK",
      "inoculation prompting",
      "unlearning",
    ],
  },
  {
    id: "control",
    name: "Control",
    gloss: "assume that failed, contain it anyway",
    techniques: [
      "trusted monitoring",
      "CoT monitoring",
      "resampling",
      "trusted editing",
      "permissioning",
      "sandboxing",
      "irreversibility limits",
      "control evaluations",
    ],
  },
  {
    id: "whiteBox",
    name: "White-box",
    gloss: "read and edit the internals",
    techniques: [
      "features",
      "circuits",
      "sparse autoencoders",
      "deception probes",
      "activation steering",
      "model diffing",
      "developmental interpretability",
    ],
  },
  {
    id: "evals",
    name: "Evals and assurance",
    gloss: "find out whether any of it worked",
    techniques: [
      "capability evals",
      "propensity evals",
      "scheming, sandbagging and situational-awareness evals",
      "model organisms",
      "alignment audits",
      "red-teaming",
      "RSPs",
      "safety cases",
    ],
  },
  {
    id: "construction",
    name: "Safety by construction",
    gloss: "guarantees instead of evidence",
    techniques: [
      "Guaranteed-Safe AI",
      "formal verification",
      "Scientist AI",
      "non-agentic world models",
      "brainlike-AGI safety",
    ],
  },
  {
    id: "aiSolve",
    name: "Make AI solve it",
    gloss: "there isn't time to do this by hand",
    techniques: [
      "weak-to-strong generalization",
      "automated auditing",
      "supervising AIs improving AIs",
      "AI explanations of AIs",
      "introspection training",
    ],
  },
];

export const SAFETY_AREA_BY_ID: Readonly<Record<SafetyAreaId, SafetyArea>> = Object.fromEntries(
  SAFETY_AREAS.map((area) => [area.id, area]),
) as Record<SafetyAreaId, SafetyArea>;

// The review's own framing of how the six fit together, quoted so the tab can say why these six.
export const TAXONOMY_FRAMING =
  "Two bets (alignment, control), two ways of checking whether they worked (white-box, evals), " +
  "one bet that both are hopeless (construction), one that we're out of time (make AI solve it). " +
  "Technical AGI safety only, so misuse and power concentration aren't in it.";
