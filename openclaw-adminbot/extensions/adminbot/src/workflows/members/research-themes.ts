// Which of the lab's research themes a member's own words place them in.
//
// The roster asks people to describe their interests in free text, and they do -- "Multi-Agent",
// "multi-agent systems", "Multi Agent LLM systems" and "Multiagent LLMs" are four members
// describing one theme. The variety is lexical rather than conceptual, which is what makes a
// phrase table the right tool here: the work is normalising spelling, not understanding meaning.
//
// Three properties this deliberately has, all of them in service of the same thing -- a
// classification somebody can argue with:
//
//   1. It reports *evidence*. Every match names the phrase that produced it, so "why is she on the
//      causal list" has an answer that does not require rerunning anything.
//   2. It never writes. This is an inference about a person's work, drawn from a field they wrote
//      for a different purpose, and the roster's own rule is that inference does not overwrite what
//      a member said about themselves. Callers get suggestions; a human assigns a theme.
//   3. It is deterministic. The same profile classifies the same way today and in March, which is
//      what makes a diff of last month's assignment meaningful.
//
// Deliberately *not* an LLM call. A model would catch the phrasing no table anticipates, at the
// cost of every property above: no stable evidence, no reproducibility, and a per-member API call
// to answer a question that string matching answers correctly for this roster today. If the themes
// grow past what phrases can separate, that trade is worth revisiting -- it is not worth it yet.
import {
  adminBotIsAlumniMember,
  adminBotIsCoauthorMajorType,
  adminBotIsFullMemberType,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import { type AdminBotThemedMeeting, themeOfEvent, topicTokens } from "./topic-channels.js";

export const RESEARCH_THEME_IDS = [
  "loss_of_control",
  "multi_agent",
  "mech_interp",
  "causal_llm",
  "post_training",
  "adversarial_defense",
] as const;

export type ResearchThemeId = (typeof RESEARCH_THEME_IDS)[number];

export type ResearchTheme = {
  id: ResearchThemeId;
  label: string;
  /**
   * The topic used to find this theme's Wednesday meeting, matched against the event's own title.
   *
   * Carried separately from `label` rather than derived from it, because the label is prose for a
   * human ("Loss of control / power concentration") and this is a matching key. Deriving one from
   * the other means every re-wording of a label silently re-points a calendar sweep.
   */
  meetingTopic: string;
  /**
   * Normalised phrases that place a member in the theme, matched whole rather than as substrings.
   *
   * Whole-phrase matching is what keeps "control" out of "controlled experiment" and "sae" out of
   * "saesthetics". Every spelling a member actually used is listed rather than derived, because a
   * stemmer that turns "causality" into "causal" also turns "training" into "train" and starts
   * claiming people.
   */
  patterns: readonly string[];
};

export const RESEARCH_THEMES: readonly ResearchTheme[] = [
  {
    id: "loss_of_control",
    label: "Loss of control / power concentration",
    meetingTopic: "loss of control",
    patterns: [
      "loss of control",
      "losing control",
      "out of control",
      "ai control",
      "agi control",
      "control problem",
      "cot monitoring",
      "chain of thought monitoring",
      "power concentration",
      "concentration of power",
      "disempowerment",
      "takeover",
      "existential risk",
      "x risk",
      "misalignment",
      "emergent misalignment",
      "scheming",
      "deception",
      "deceptive alignment",
    ],
  },
  {
    id: "multi_agent",
    label: "Multi-agent",
    meetingTopic: "multi agent",
    patterns: [
      "multi agent",
      "multiagent",
      "multi agents",
      "multi agent systems",
      // "Agentic and multi agentic Safety" is on the roster verbatim. Whole-phrase matching means
      // "multi agent" does not reach "multi agentic", so the adjective is listed in its own right.
      "multi agentic",
      "multiagentic",
      "agent systems",
      "game theory",
      "game theoretic",
      "cooperative ai",
      "negotiation",
      "negotiation protocols",
      "social simulation",
      "collective intelligence",
      "theory of mind",
      "mechanism design",
    ],
  },
  {
    id: "mech_interp",
    label: "Mech-interp",
    meetingTopic: "mech interp",
    patterns: [
      "mech interp",
      "mechinterp",
      "mechanistic interpretability",
      "interpretability",
      "interp",
      "sparse autoencoder",
      "sparse autoencoders",
      "sae",
      "saes",
      "circuit analysis",
      "circuit discovery",
      "activation steering",
      "activation patching",
      "probing",
      "feature attribution",
      "influence function",
      "influence functions",
    ],
  },
  {
    id: "causal_llm",
    label: "Causal LLM",
    meetingTopic: "causal llm",
    patterns: [
      "causal",
      "causality",
      "causal llm",
      "causal llms",
      "causal inference",
      "causal reasoning",
      "causal discovery",
      "causal graph",
      "causal graphs",
      "causal representation learning",
      "structural causal model",
      "counterfactual",
      "counterfactuals",
    ],
  },
  {
    id: "post_training",
    label: "Post-training",
    meetingTopic: "post training",
    patterns: [
      "post training",
      "posttraining",
      "post trained",
      "fine tuning",
      "finetuning",
      "fine tuned",
      "instruction tuning",
      "rlhf",
      "rlaif",
      "dpo",
      "sft",
      "preference optimization",
      "preference learning",
      "reward modeling",
      "reward model",
      "alignment tuning",
      "continual learning",
      "character training",
      "persona training",
    ],
  },
  {
    id: "adversarial_defense",
    label: "Adversarial defense",
    meetingTopic: "adversarial defense",
    patterns: [
      "adversarial",
      "adversarial defense",
      "adversarial defence",
      "adversarial robustness",
      "adversarial attack",
      "adversarial attacks",
      "adversarial examples",
      "robustness",
      "jailbreak",
      "jailbreaks",
      "jailbreaking",
      "red team",
      "red teaming",
      "redteaming",
      "prompt injection",
      "guardrail",
      "guardrails",
    ],
  },
];

/** One theme a member matched, and the text that put them there. */
export type ThemeMatch = {
  theme: ResearchThemeId;
  label: string;
  /**
   * The phrases that matched, and the member's own text each came from.
   *
   * Both halves matter to a reviewer: the phrase says which rule fired, and the source says what
   * the member actually wrote, which is how a wrong match gets diagnosed as a bad pattern rather
   * than argued about in the abstract.
   */
  evidence: readonly { pattern: string; source: string }[];
};

/**
 * Normalise free text to space-separated lowercase tokens.
 *
 * Every non-alphanumeric run becomes a single space, which is what collapses "Multi-Agent",
 * "Multi Agent" and "multi_agent" onto one string. "Multiagent" does *not* collapse onto it -- no
 * amount of punctuation handling joins or splits a word -- so it is listed as its own pattern
 * above rather than papered over here.
 */
export function normalizeThemeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/** Whether a normalised haystack contains `pattern` as a whole phrase. */
function containsPhrase(haystack: string, pattern: string): boolean {
  return ` ${haystack} `.includes(` ${pattern} `);
}

/**
 * The themes a member's research interests and projects place them in, with evidence.
 *
 * Multi-label by design: somebody working on adversarial attacks against multi-agent systems is on
 * both lists, and forcing a single answer would lose the fact the lab actually wants.
 *
 * Returns an empty array for a member who has written nothing matching -- which is a real answer
 * and not a failure. A profile with no interests filled in cannot be classified, and guessing from
 * a name or a channel would be the kind of inference this module exists to avoid.
 */
export function classifyMemberThemes(member: AdminBotLabMember): ThemeMatch[] {
  // Both fields, because they answer the same question in different words: `research_topics` is
  // what somebody says they work on and `projects` is what they are actually on. Either alone
  // misses people -- several members list only projects, and several list only topics.
  const sources = [...(member.research_topics ?? []), ...(member.projects ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  const normalized = sources.map((source) => ({ source, text: normalizeThemeText(source) }));

  const matches: ThemeMatch[] = [];
  for (const theme of RESEARCH_THEMES) {
    const evidence: { pattern: string; source: string }[] = [];
    for (const { source, text } of normalized) {
      for (const pattern of theme.patterns) {
        if (containsPhrase(text, pattern)) {
          evidence.push({ pattern, source });
        }
      }
    }
    if (evidence.length > 0) {
      matches.push({ theme: theme.id, label: theme.label, evidence: dedupe(evidence) });
    }
  }
  return matches;
}

/**
 * Collapse evidence to one row per (pattern, source).
 *
 * A member who lists "Causal Inference" and "Causal LLM" matches `causal` twice, and repeating it
 * would make the evidence list read as strength of a signal rather than what it is -- a list of
 * places to go and look.
 */
function dedupe(
  evidence: readonly { pattern: string; source: string }[],
): { pattern: string; source: string }[] {
  const seen = new Map<string, { pattern: string; source: string }>();
  for (const item of evidence) {
    seen.set(`${item.pattern} ${item.source}`, item);
  }
  return [...seen.values()];
}

/** Just the theme ids, for a caller that wants the labels and not the reasoning. */
export function memberThemeIds(member: AdminBotLabMember): ResearchThemeId[] {
  return classifyMemberThemes(member).map((match) => match.theme);
}

/**
 * Whether this person is one the theme meetings are for.
 *
 * Full members and major coauthors: the people carrying the lab's work, as the roster spreadsheet
 * records it rather than as `privilege_level` guesses -- see adminBotIsFullMemberType for why that
 * distinction has bitten a sweep before. Everyone else on the roster is a minor coauthor, an
 * interviewee, a mailing-list address or an external professor, and a standing Wednesday invite is
 * not what any of them signed up for.
 *
 * Alumni are excluded even when the type still says full, because the roster keeps the old type
 * after somebody leaves -- the same trap adminBotIsAlumniMember exists to close.
 */
export function isThemeMeetingEligible(member: AdminBotLabMember): boolean {
  if (adminBotIsAlumniMember(member)) {
    return false;
  }
  return (
    adminBotIsFullMemberType(member.member_type) || adminBotIsCoauthorMajorType(member.member_type)
  );
}

/**
 * The Wednesday meeting for a theme, out of the events handed in.
 *
 * The theme's topic has to be fully present in the event's title, not the reverse -- the same rule
 * matchThemedMeetings uses for channels, so "Theme: Causal LLM Meeting" and "Theme: Causal
 * Inference" both answer to the causal theme while a narrower event does not get claimed by it.
 *
 * Returns every match rather than picking one. Two events answering to one theme is a calendar
 * somebody should look at -- the lab currently has two "Theme: Causal LLM" entries at the same
 * hour -- and silently inviting people to the first would hide that.
 */
export function themeMeetings(
  themeId: ResearchThemeId,
  meetings: readonly AdminBotThemedMeeting[],
): AdminBotThemedMeeting[] {
  const theme = RESEARCH_THEMES.find((entry) => entry.id === themeId);
  if (!theme) {
    return [];
  }
  const wanted = topicTokens(theme.meetingTopic);
  if (wanted.length === 0) {
    return [];
  }
  return meetings.filter((meeting) => {
    const title = themeOfEvent(meeting.summary);
    if (!title) {
      return false;
    }
    const have = new Set(topicTokens(title));
    return wanted.every((token) => have.has(token));
  });
}
