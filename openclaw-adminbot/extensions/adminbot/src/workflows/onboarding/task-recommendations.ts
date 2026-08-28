// The per-applicant "Zhijing's personal recommendation" sentence in the project-matching mail.
//
// This used to be one hard-coded sentence about the WordPlay RL modular task, sent to every
// applicant regardless of what they had actually applied with. It produced recommendations that
// did not match the person -- the review of the August batch caught one that named work the
// applicant had no connection to -- so the sentence is now chosen per applicant from this catalog
// rather than written into the template.
//
// The catalog is the single source for both the email and the batch JSON, so a reviewer who
// corrects the wording here does not then have to find the same sentence in a generated file.
// Wording is the lab's, verbatim; only the bracketed fragments are ours.

/** A recommendation whose text needs a fragment the operator supplies per applicant. */
export type TaskRecommendationPlaceholder = {
  readonly token: string;
  readonly describes: string;
};

export type AdminBotTaskRecommendation = {
  readonly id: string;
  /** What this recommendation is for, shown to the operator picking one. */
  readonly summary: string;
  readonly text: string;
  readonly placeholders?: readonly TaskRecommendationPlaceholder[];
};

/**
 * A phrase that must never reach an applicant again.
 *
 * It promised a document the project lead would share, which is not how any of these matches
 * actually work -- the lead replies on the thread instead. It was struck from the copy by name, so
 * it is asserted against rather than merely deleted: a future edit that reintroduces it fails the
 * suite.
 */
export const RETIRED_RECOMMENDATION_PHRASES: readonly string[] = [
  ", where you can work on AdminBot following the doc they will share with you",
  "WordPlay RL training modular task",
];

export const ADMINBOT_TASK_RECOMMENDATIONS = [
  {
    // The default for anyone whose match is AdminBot and nothing else. Named in the review as the
    // correction for xinping.song@mail.utoronto.ca and for "all adminbot-only tasks".
    id: "adminbot_only",
    summary: "AdminBot coding test tasks, with Andrew (the adminbot-only default)",
    text: `Zhijing's personal recommendation is to match you with Andrew for some coding test tasks for our AdminBot project.`,
  },
  {
    // The same match, phrased for an applicant whose own background is worth naming. The two
    // variants below differ only in the clause the lab supplied for that applicant.
    id: "adminbot_career_launch",
    summary: "AdminBot work led by Andrew, for an applicant with Career Launch Agent experience",
    text: `Zhijing's personal recommendation is to match you with the AdminBot work led by Andrew, especially your past project experience in the Career Launch Agent and you can also help collect resume-related datasets for admission and job applications.`,
  },
  {
    id: "adminbot_openrouter_privacy",
    summary: "AdminBot work led by Andrew, on privacy-aware pre-processing for OpenRouter calls",
    text: `Zhijing's personal recommendation is to match you with the AdminBot work led by Andrew, where you can help implement privacy-aware LLM pre-processing before sending a query to the OpenRouter API calls.`,
  },
  {
    id: "causaltutor_rahul",
    summary: "CausalTutor human-subject work with Rahul, then modular tasks",
    text: `Zhijing's personal recommendation is to match you with the CausalTutor human-subject work led by Rahul, starting there first and then moving on to simple modular tasks.`,
  },
  {
    // The two-match variant. The lab's note breaks off mid-sentence at "focusing on", so the topic
    // is a placeholder rather than a guess: an applicant must not be told they are being matched to
    // a causality study whose subject we invented for them.
    id: "adminbot_and_causaltutor",
    summary: "Both: an AdminBot test task with Andrew, and a CausalTutor human test with Rahul",
    text: `Zhijing's personal recommendation is to match you (1) with Andrew for a test task about AdminBot programming (e.g., enabling Chrome and cache checks), and (2) with Rahul to do a human test to use CausalTutor to learn about causality from scratch, focusing on {causal_topic}.`,
    placeholders: [
      { token: "causal_topic", describes: "what the CausalTutor human test should focus on" },
    ],
  },
] as const satisfies readonly AdminBotTaskRecommendation[];

export type AdminBotTaskRecommendationId = (typeof ADMINBOT_TASK_RECOMMENDATIONS)[number]["id"];

export function findTaskRecommendation(id: string): AdminBotTaskRecommendation | undefined {
  return ADMINBOT_TASK_RECOMMENDATIONS.find((entry) => entry.id === id);
}

export type TaskRecommendationResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: "unknown-id" | "missing-values";
      readonly missing: readonly string[];
    };

/**
 * Renders one recommendation, refusing rather than shipping a half-filled sentence.
 *
 * Same contract as the guide compose: an unfilled placeholder reaching an applicant is worse than
 * the mail not going out, and it is worse still here, because the sentence claims to be Zhijing's
 * personal judgement about that specific person.
 */
export function renderTaskRecommendation(
  id: string,
  values: Readonly<Record<string, string | undefined>> = {},
): TaskRecommendationResult {
  const recommendation = findTaskRecommendation(id);
  if (!recommendation) {
    return { ok: false, reason: "unknown-id", missing: [] };
  }
  const missing = (recommendation.placeholders ?? [])
    .map((placeholder) => placeholder.token)
    .filter((token) => !values[token]?.trim());
  if (missing.length > 0) {
    return { ok: false, reason: "missing-values", missing };
  }
  const text = recommendation.text.replace(
    /\{([a-z_]+)\}/gu,
    (whole, token: string) => values[token]?.trim() ?? whole,
  );
  return { ok: true, text };
}
