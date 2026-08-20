/**
 * The Jinesis LinkedIn draft: prompt, author verification, and shape checks.
 *
 * Pure by construction. Everything in this file builds strings and compares names. The
 * OpenRouter call that turns the prompt into a post lives in `connectors/social-draft.ts`,
 * because a workflow never touches a vendor -- see AGENTS.md and docs/architecture.md.
 *
 * The prompt below is the lab's real one, carried over verbatim from the standalone
 * `paper-post-lib.mjs` generator. It is long because every rule in it was earned: the
 * grounding clause exists because the model invented numbers, the author clause because it
 * dropped middle authors, the plain-text clause because LinkedIn renders no markdown and
 * silently ships the asterisks.
 */

import type { AdminBotLabMember } from "../../contracts/actions.js";

/** What the draft is written from. `abstract` is the only permitted source of claims. */
export type AdminBotPaperSource = {
  title: string;
  authors: string[];
  abstract: string;
  url?: string;
};

/**
 * One author, checked against the AdminBot member roster.
 *
 * `match` is reported rather than reduced to a boolean because "same surname, same first
 * initial" is a guess: it is right often enough to be worth making and wrong often enough
 * that a human approving the post should see which kind of match they are trusting.
 */
export type AdminBotVerifiedAuthor = {
  /** The name exactly as the paper spells it, after "Last, First" is flipped. */
  paperName: string;
  /** The registered member's spelling when matched, otherwise the paper's. */
  displayName: string;
  matched: boolean;
  match: "none" | "exact" | "initial";
  member_id?: string;
  linkedin_url?: string;
  /** Required to turn a name into a real @mention; LinkedIn's API addresses people by URN. */
  linkedin_urn?: string;
  twitter_url?: string;
};

export const JINESIS_LINKEDIN_SYSTEM_PROMPT = `You write LinkedIn posts for the official page of Jinesis Lab at the University of Toronto (PI: Prof. Zhijing Jin — NLP, causal reasoning, multi-agent safety, AI safety, AI for science/social good).

HARD RULES:
- Plain text + emoji ONLY. LinkedIn renders no markdown: never use **bold**, *italics*, [links](), bullets with "-" are fine but never "*".
- GROUNDING: the paper's ABSTRACT is your only source about the paper. Every claim, finding, and number in the post must be a plain restatement of something the abstract explicitly says. Keep findings simple and faithful — do not add background knowledge, do not generalize beyond the abstract's scope, do not infer results the abstract does not state. If the abstract gives no numbers, the post has no numbers.
- Never invent results, numbers, quotes, venues, awards, poster numbers, dates, links, or affiliations that were not given to you.
- AUTHORS: always credit the COMPLETE author list from the paper — every author, in the exact order given, none skipped. Use the spellings EXACTLY as in the "Authors (verified)" list (these come from the paper and the lab's official contact sheet). Do not re-spell, initialize, reorder, or drop anyone.
- If venue/poster/session details are provided, include them with field-emoji lines (📍 location, 🗓️ or 📅 date, ⏰ or 🕚 time, 📌 poster number). If not provided, do not fabricate any.
- Include the paper link on its own line prefixed with 📄 (plus 💻 code / 🌐 project page lines only if such links are given).
- End with 5–10 relevant hashtags in the lab's typical space-separated style (#ICML2026 #AISafety #LLM #CausalInference #MultiAgentSystems #MachineLearning #NLP #AIResearch — pick ones fitting THIS paper).
- Length 900–2200 characters.

VOICE (learned from the lab's real posts): enthusiastic but scientifically precise "we" lab voice. Celebration emojis (🎉🚀🌟🤝) used naturally, not on every line. Findings and contributions are concrete — name the benchmark/method/framework and say what it actually shows.

REAL EXAMPLES OF THE LAB'S POSTS (match this style, NEVER copy their sentences):

--- Example 1 (full announcement with poster session) ---
🚨 Can LLMs actually perform causal inference on real-world scientific data?

Excited to share CauSciBench at #ICML2026! 🎉

As LLMs are increasingly used for scientific reasoning, an important question remains: can they go beyond surface-level prediction to support the methodological decisions required for causal inference?

The benchmark evaluates whether LLMs can:
🧭 Identify the right causal estimand
⚙️ Select an appropriate causal inference method
🔎 Reason about treatment, outcome, covariates, and causal variables
🧪 Handle realistic scientific settings where assumptions matter

Our results show that causal inference remains a serious challenge for today's LLMs.

📍 Come check out the poster at #ICML2026
🗓 Thu, July 9
⏰ 10:30 AM–12:15 PM KST
📌 Hall A · Poster #4403
👥 Authors: Sawal Acharya, Terry J. C. Zhang, Andrew Kim, ... and Zhijing Jin

📄 Paper: <link>

#CausalInference #LLMs #ScientificAI #MachineLearning #ICML2026 #AIResearch #Causality

--- Example 2 (short new-paper alert) ---
🚨 New paper: Cheap Talk, Empty Promise: Frontier LLMs easily break public promises for self-interest

Can we trust #LLM agents to keep their promises? We tested 9 frontier LLMs in game-theoretic settings, where the agents (1) publicly commit to an action, (2) privately choose what to do — breaking promises ~57% of the time, and most do it without even realizing they lied.

Paper: <link>

Joint work by Jerick Shi, Terry Jingchen Zhang, Zhijing Jin, Vincent Conitzer!

#AIAgents #AISafety #MultiAgentAI

Thank you for the institutional support University of Toronto, Carnegie Mellon University, Jinesis Lab at the University of Toronto!

--- Example 3 (numbered findings style) ---
🚀 Excited to share our #ICML2026 paper: Training with Honeypots: Reshaping How LLMs Fail Under Adversarial Attacks

📌 Our paper asks:
LLM jailbreaks aren't all equally dangerous. So why do we evaluate them as if they are?

🔍 Findings:
1️⃣ Standard automated safety judges often assign high violation scores to honeypot responses...
2️⃣ Honeypot-based defenses reduce average attack success rates across models, judges, and attack settings...
3️⃣ When defenses still fail, the failures shift toward lower-actionability outputs...

💡 Takeaways
AI safety evaluations should not only ask: Did the model fail?
They should also ask: How dangerous was the failure?

📍Find us at our Poster Session: ...
Co-authors: Samuel Šimko, Punya Syon Pandey, Zhijing Jin, Bernhard Schölkopf

📄Paper Link: <link>

#ICML2026 #AISafety #LLMSafety #MachineLearning #AIAlignment
---

Output ONLY the post text — no preamble, no code fences, no commentary.`;

/**
 * Per-run structure directives, so consecutive posts do not share a skeleton.
 *
 * Without these the model converges on one shape and the lab's feed reads as a template.
 */
const HOOKS = [
  'Open with 🚨 + a provocative yes/no research question ("Can LLMs actually ...?", "Can we trust ... ?").',
  'Open with a "What if ...?" thought experiment question + 🤔 or similar.',
  'Open with "Thrilled to share ..." or "Excited to share ..." + 🎉 announcing the paper directly.',
  'Open with "🚨 New paper: <title>" then dive straight into the core question.',
  "Open with a bold one-line claim from the paper's core insight, then introduce the paper.",
];
const BULLET_STYLES = [
  "Use numbered emoji bullets (1️⃣ 2️⃣ 3️⃣) for findings.",
  "Use varied topical emoji bullets (🔍 💡 🧩 📊 ⚡ 🧭 ⚙️ 🧪 — pick ones matching each point) for findings.",
  "Use 📌 bullets for contributions and a short prose paragraph for the main finding.",
  "Skip bullets entirely: write 2-3 tight prose paragraphs (short-alert style like Example 2).",
];
const CREDIT_STYLES = [
  '"👥 Authors: <names>" on one line.',
  '"Joint work by <names>!" as a sentence.',
  '"This work was led by <first author>, with <rest>."',
  '"Co-authors: <names>" on one line.',
];

export type AdminBotDraftRandom = () => number;

export function pickDirectives(random: AdminBotDraftRandom = Math.random): string {
  const pick = (options: readonly string[]): string =>
    options[Math.min(options.length - 1, Math.floor(random() * options.length))];
  return [
    "STRUCTURE FOR THIS POST (vary from previous posts):",
    `- ${pick(HOOKS)}`,
    `- ${pick(BULLET_STYLES)}`,
    `- Credit authors as: ${pick(CREDIT_STYLES)}`,
  ].join("\n");
}

// ── author verification against the AdminBot roster ──────────────────────────────────────
//
// This replaces the standalone generator's `contacts.json`, a hand-maintained spreadsheet
// export. The roster is the same population but it is live, so a member who updates their
// own LinkedIn URL is immediately taggable and a name that has drifted is caught here rather
// than shipped in a post.

/**
 * Fold a name to something comparable: accents stripped, punctuation dropped, case flattened.
 *
 * The accent strip is what makes "Schölkopf" match "Scholkopf" and "Šimko" match "Simko".
 * Author lists and rosters disagree about diacritics constantly, and a false "not in the
 * roster" is worse than useless: it trains the reviewer to ignore the warning.
 */
export function normalizePersonName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z ]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** arXiv and BibTeX render authors as "Last, First"; everything downstream wants "First Last". */
export function toFirstLast(author: string): string {
  const comma = author.indexOf(",");
  if (comma < 0) {
    return author.trim();
  }
  const last = author.slice(0, comma).trim();
  const first = author.slice(comma + 1).trim();
  return first ? `${first} ${last}` : last;
}

/**
 * Cross-check the paper's author list against registered members.
 *
 * Order is preserved and nobody is dropped: an unmatched author still comes back, spelled the
 * way the paper spells them. Silently omitting an author the roster does not know would be the
 * one failure mode worse than a wrong tag.
 */
export function verifyAuthorsAgainstMembers(
  authors: string[],
  members: AdminBotLabMember[],
): AdminBotVerifiedAuthor[] {
  const index = members.map((member) => ({ member, norm: normalizePersonName(member.name) }));

  return authors
    .map((raw) => toFirstLast(raw))
    .filter((name) => name.length > 0)
    .map((paperName) => {
      const norm = normalizePersonName(paperName);
      const exact = index.find((entry) => entry.norm === norm);
      if (exact) {
        return describe(paperName, exact.member, "exact");
      }

      // Fallback: same surname and same first initial, but only when it is unambiguous. Two
      // candidates means we cannot tell them apart, and guessing between two real people is
      // exactly the mistake that puts the wrong person's name on a public post.
      const parts = norm.split(" ");
      const surname = parts[parts.length - 1];
      const initial = parts[0]?.[0];
      const candidates = index.filter((entry) => {
        const entryParts = entry.norm.split(" ");
        return entryParts[entryParts.length - 1] === surname && entryParts[0]?.[0] === initial;
      });
      if (candidates.length === 1 && candidates[0]) {
        return describe(paperName, candidates[0].member, "initial");
      }

      return { paperName, displayName: paperName, matched: false, match: "none" as const };
    });
}

function describe(
  paperName: string,
  member: AdminBotLabMember,
  match: "exact" | "initial",
): AdminBotVerifiedAuthor {
  return {
    paperName,
    // The roster's spelling wins: it is what the person chose to be called.
    displayName: member.name,
    matched: true,
    match,
    member_id: member.id,
    ...(member.linkedin_url ? { linkedin_url: member.linkedin_url } : {}),
    ...(member.linkedin_urn ? { linkedin_urn: member.linkedin_urn } : {}),
    ...(member.twitter_url ? { twitter_url: member.twitter_url } : {}),
  };
}

// ── prompt assembly ──────────────────────────────────────────────────────────────────────

export type AdminBotLinkedInDraftPrompt = { system: string; user: string };

export type AdminBotLinkedInDraftInput = {
  paper: AdminBotPaperSource;
  authorsVerified: AdminBotVerifiedAuthor[];
  /** Venue/session details. Omitted rather than invented -- the prompt forbids guessing them. */
  venue?: string;
  note?: string;
  directives?: string;
};

export function buildLinkedInDraftPrompt(
  input: AdminBotLinkedInDraftInput,
): AdminBotLinkedInDraftPrompt {
  const { paper, authorsVerified, venue, note } = input;
  const authorLines = authorsVerified.length
    ? authorsVerified
        .map((author) => `- ${author.displayName}${author.matched ? " (verified lab member)" : ""}`)
        .join("\n")
    : "(none extracted — omit author credits rather than guessing)";

  const user = [
    "Write one Jinesis Lab LinkedIn post for this paper.",
    "",
    `Title: ${paper.title}`,
    paper.url
      ? `Link: ${paper.url}`
      : "Link: none available — OMIT the paper-link line entirely.",
    venue?.trim()
      ? `Venue / event details (use them): ${venue.trim()}`
      : "Venue: not stated — do NOT mention any venue or acceptance.",
    ...(note?.trim() ? [`Extra context from the lab (use it): ${note.trim()}`] : []),
    "",
    "Authors (verified) — from the paper itself; credit ALL of them, exact spellings, in this order:",
    authorLines,
    "",
    "Abstract — your ONLY source about this paper; restate, never extrapolate:",
    paper.abstract,
    "",
    input.directives ?? pickDirectives(),
  ].join("\n");

  return { system: JINESIS_LINKEDIN_SYSTEM_PROMPT, user };
}

// ── output shape ─────────────────────────────────────────────────────────────────────────

/**
 * LinkedIn renders no markdown, so emphasis the model sneaks in ships as literal asterisks.
 * Stripped rather than rejected: it is a formatting slip, not a grounding failure.
 */
export function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gu, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gu, "$1$2");
}

/** Hashtags in document order, deduplicated case-insensitively. */
export function extractHashtags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const tag = `#${match[1]}`;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

export const LINKEDIN_DRAFT_MIN_CHARS = 900;
export const LINKEDIN_DRAFT_MAX_CHARS = 2200;
const HASHTAG_MIN = 5;
const HASHTAG_MAX = 10;

/**
 * What is wrong with a draft, as a list a reviewer can read.
 *
 * Advisory on purpose: these are returned, never thrown. A draft is a proposal a human is
 * about to read anyway, and refusing to show them a 2,300-character post -- rather than
 * showing it with "82 characters over" attached -- would hide the work that was already paid for.
 */
export function reviewLinkedInDraft(
  text: string,
  authorsVerified: AdminBotVerifiedAuthor[] = [],
): string[] {
  const issues: string[] = [];
  // Code points, not UTF-16 units: LinkedIn counts an emoji as one character and so must we.
  const length = Array.from(text).length;
  if (length < LINKEDIN_DRAFT_MIN_CHARS) {
    issues.push(`post is ${LINKEDIN_DRAFT_MIN_CHARS - length} characters short of the 900 minimum`);
  }
  if (length > LINKEDIN_DRAFT_MAX_CHARS) {
    issues.push(`post is ${length - LINKEDIN_DRAFT_MAX_CHARS} characters over the 2200 maximum`);
  }

  const hashtags = extractHashtags(text);
  if (hashtags.length < HASHTAG_MIN) {
    issues.push(`only ${hashtags.length} hashtags; the lab's posts carry ${HASHTAG_MIN}-${HASHTAG_MAX}`);
  }
  if (hashtags.length > HASHTAG_MAX) {
    issues.push(`${hashtags.length} hashtags; the lab's posts carry ${HASHTAG_MIN}-${HASHTAG_MAX}`);
  }

  if (/\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/u.test(text)) {
    issues.push("contains markdown, which LinkedIn will render as literal characters");
  }

  // The failure the prompt works hardest to prevent, checked rather than trusted.
  const missing = authorsVerified.filter((author) => !text.includes(author.displayName));
  if (missing.length > 0) {
    issues.push(`author(s) missing from the post: ${missing.map((a) => a.displayName).join(", ")}`);
  }

  return issues;
}
