// The two things the lab asks of a talk once a paper has gone out: put your slides into the topic's
// shared mega deck, and add the work to the lab's Quick Pointers doc.
//
// The PI builds each talk by copying a subset of a topic's mega deck, so the deck only works if
// everyone appends and nobody deletes; Quick Pointers is the by-topic list of the lab's core work
// that conferences and grant track records are read off.
//
// Neither is a paper slot. Nobody can verify either from a link (the deck is one shared file the
// student only appends to), so there is nothing to store and nothing to validate -- they are
// reminders, said once, in the same message as whatever else the person owes on that paper. The
// weekly talk-slides chase names the same deck in its own line, so the two read as one ask.
//
// Pure. The deck URLs are deployment config (ADMINBOT_TALK_MATERIALS_JSON). The one link known
// here is the lab's public Quick Pointers doc, used when the config names none.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  ADMINBOT_QUICK_POINTERS_DOC_URL,
  adminBotPaperSlotBranchPriority,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import { isPaperClosed, isPaperDormant, type NudgeItem } from "./paper-slots.js";

export type AdminBotTalkTopicMaterials = {
  /** How the topic reads in a message, e.g. "causality". Defaults to the config key. */
  label?: string;
  /**
   * Other words that put a research branch or topic under this one ("causal" for causality). A
   * branch matches when it equals or mentions the key, the label or any alias.
   */
  aliases?: string[];
  mega_deck_url?: string;
  /** A topic-specific Quick Pointers doc. Most labs have one doc; see the top-level field. */
  quickpointers_url?: string;
};

export type AdminBotTalkMaterialsConfig = {
  /** Keyed by topic slug, matched against the first author's research branch and topics. */
  topics: Record<string, AdminBotTalkTopicMaterials>;
  /** Used when the author's research branch matches no topic. */
  default_topic?: string;
  /** The lab-wide Quick Pointers doc. Unset: `ADMINBOT_QUICK_POINTERS_DOC_URL`. */
  quickpointers_url?: string;
  /**
   * Where every mega deck is listed, linked when the author matches no topic. Unset: the Quick
   * Pointers doc, whose section for each theme links that theme's deck.
   */
  decks_index_url?: string;
};

/**
 * What one author is pointed at, resolved: the paper card and the nudge both read this, so they
 * cannot disagree about which deck a paper belongs in.
 */
export type AdminBotTalkMaterialsView = {
  topic_key?: string;
  topic_label?: string;
  /** Absent when no topic matched, or the matched topic has no deck configured. */
  mega_deck_url?: string;
  quickpointers_url: string;
  /** Always present: the fallback when there is no deck to name. */
  decks_index_url: string;
};

export const emptyTalkMaterialsConfig: AdminBotTalkMaterialsConfig = { topics: {} };

/**
 * How long after the submission (or the slides) the reminder is still worth sending.
 *
 * The trigger is "this just happened", not "this is true". Without a window, the first sweep after
 * deploy would remind every author of every paper the lab ever submitted.
 */
export const TALK_MATERIALS_WINDOW_DAYS = 120;

const DAY_MS = 1000 * 60 * 60 * 24;

export const talkMegaDeckSuffix = "talk_mega_deck";
export const talkQuickPointersSuffix = "talk_quickpointers";

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  try {
    return new URL(trimmed).protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Reads the JSON config, failing soft.
 *
 * A malformed value turns into "no links configured", which still sends a generic reminder: the
 * reminder is the point, the link a convenience. Anything that is not an https URL is dropped
 * rather than put in front of a student.
 */
export function parseTalkMaterialsConfig(raw: unknown): AdminBotTalkMaterialsConfig {
  let value = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) {
      return { topics: {} };
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return { topics: {} };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { topics: {} };
  }
  const record = value as Record<string, unknown>;
  const topicsRaw =
    record.topics && typeof record.topics === "object" && !Array.isArray(record.topics)
      ? (record.topics as Record<string, unknown>)
      : {};
  const topics: Record<string, AdminBotTalkTopicMaterials> = {};
  for (const [key, entry] of Object.entries(topicsRaw)) {
    const slug = key.trim().toLowerCase();
    if (!slug || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const fields = entry as Record<string, unknown>;
    const label = text(fields.label);
    const aliases = Array.isArray(fields.aliases)
      ? fields.aliases.flatMap((alias) => {
          const value = text(alias)?.toLowerCase();
          return value ? [value] : [];
        })
      : [];
    const deck = httpsUrl(fields.mega_deck_url);
    const pointers = httpsUrl(fields.quickpointers_url);
    topics[slug] = {
      ...(label ? { label } : {}),
      ...(aliases.length ? { aliases } : {}),
      ...(deck ? { mega_deck_url: deck } : {}),
      ...(pointers ? { quickpointers_url: pointers } : {}),
    };
  }
  const fallback = text(record.default_topic)?.toLowerCase();
  const pointers = httpsUrl(record.quickpointers_url);
  const index = httpsUrl(record.decks_index_url);
  return {
    topics,
    ...(fallback && topics[fallback] ? { default_topic: fallback } : {}),
    ...(pointers ? { quickpointers_url: pointers } : {}),
    ...(index ? { decks_index_url: index } : {}),
  };
}

/**
 * Which configured topic an author belongs to. Each hint (the research branch first, then the
 * research topics) is tried in turn: by key, label or alias, case-insensitively, then by the hint
 * mentioning one ("causal inference" finds "causal"). Then the default.
 */
export function resolveTalkTopic(
  config: AdminBotTalkMaterialsConfig,
  hints: string | undefined | readonly (string | undefined)[],
): { key: string; materials: AdminBotTalkTopicMaterials } | undefined {
  const entries = Object.entries(config.topics);
  const names = (key: string, materials: AdminBotTalkTopicMaterials) => [
    key,
    ...(materials.label ? [materials.label.toLowerCase()] : []),
    ...(materials.aliases ?? []),
  ];
  const list = (Array.isArray(hints) ? hints : [hints])
    .map((hint) => (hint ?? "").trim().toLowerCase())
    .filter(Boolean);
  for (const hint of list) {
    const match =
      entries.find(([key, materials]) => names(key, materials).includes(hint)) ??
      entries.find(([key, materials]) => names(key, materials).some((name) => hint.includes(name)));
    if (match) {
      return { key: match[0], materials: match[1] };
    }
  }
  if (config.default_topic && config.topics[config.default_topic]) {
    return { key: config.default_topic, materials: config.topics[config.default_topic] };
  }
  return undefined;
}

/** The deck, Quick Pointers and deck-list links for one author, with every fallback applied. */
export function resolveTalkMaterials(
  config: AdminBotTalkMaterialsConfig,
  hints: string | undefined | readonly (string | undefined)[],
): AdminBotTalkMaterialsView {
  const topic = resolveTalkTopic(config, hints);
  const quickpointers =
    topic?.materials.quickpointers_url ??
    config.quickpointers_url ??
    ADMINBOT_QUICK_POINTERS_DOC_URL;
  return {
    ...(topic ? { topic_key: topic.key, topic_label: topic.materials.label ?? topic.key } : {}),
    ...(topic?.materials.mega_deck_url ? { mega_deck_url: topic.materials.mega_deck_url } : {}),
    quickpointers_url: quickpointers,
    decks_index_url:
      config.decks_index_url ?? config.quickpointers_url ?? ADMINBOT_QUICK_POINTERS_DOC_URL,
  };
}

const ADD_ONLY = "add your own slides; never delete, overwrite or rearrange anyone else's";

/** "the <deck|causality mega deck>", or the list of decks when there is no deck to name. */
function deckPhrase(view: AdminBotTalkMaterialsView): string {
  if (view.mega_deck_url) {
    return `the <${view.mega_deck_url}|${view.topic_label ? `${view.topic_label} ` : ""}mega deck>`;
  }
  return `your topic's mega deck (<${view.decks_index_url}|list of decks>)`;
}

/**
 * The line under the weekly talk-slides chase: make them, link them, and add them to the right
 * deck. Replaces the generic wording `actionablePaperSlots` carries, per recipient, because the
 * deck depends on whose research it is.
 */
export function talkSlidesDetail(view: AdminBotTalkMaterialsView): string {
  return `make the talk slides and link them here, then add them to ${deckPhrase(view)} -- ${ADD_ONLY}`;
}

/** Swaps the slides chase's generic detail for the author's own deck. Anything else is untouched. */
export function withTalkSlidesDetail(item: NudgeItem, view: AdminBotTalkMaterialsView): NudgeItem {
  return item.slot === "slides" && item.domain === "paper_slot"
    ? { ...item, detail: talkSlidesDetail(view) }
    : item;
}

function recentlyProvided(record: AdminBotPaperSlotRecord | undefined, now: Date): boolean {
  if (record?.status !== "provided") {
    return false;
  }
  const at = Date.parse(record.provided_at ?? "");
  if (!Number.isFinite(at)) {
    return false;
  }
  const age = now.getTime() - at;
  return age >= 0 && age <= TALK_MATERIALS_WINDOW_DAYS * DAY_MS;
}

/**
 * The deck and Quick Pointers reminders for one paper, or nothing.
 *
 * Fires once the first submission is in or the slides slot is filled -- whichever happened
 * recently. A waived submission (grandfathered by the backfill) is not a submission event.
 *
 * The deck line waits for the slides: until they are linked, the weekly slides chase already names
 * the deck, and saying it twice in one message reads as two chores. A waived slides slot means
 * there is no talk, so the deck line never comes; the Quick Pointers line still makes sense for the
 * work itself.
 */
export function talkMaterialReminders(params: {
  paper: AdminBotPaperRecord;
  stored: AdminBotPaperSlotRecord[];
  now: Date;
  config: AdminBotTalkMaterialsConfig;
  researchBranch?: string;
  researchTopics?: readonly string[];
}): NudgeItem[] {
  const { paper, stored, now } = params;
  if (isPaperDormant(paper, now) || isPaperClosed(paper)) {
    return [];
  }
  const bySlot = new Map(stored.filter((row) => row.paper_id === paper.id).map((r) => [r.slot, r]));
  const submission = bySlot.get("submission");
  const slides = bySlot.get("slides");
  if (!recentlyProvided(submission, now) && !recentlyProvided(slides, now)) {
    return [];
  }
  const view = resolveTalkMaterials(params.config, [
    params.researchBranch,
    ...(params.researchTopics ?? []),
  ]);
  const priority = adminBotPaperSlotBranchPriority.talk;
  const out: NudgeItem[] = [];
  if (slides?.status === "provided") {
    out.push({
      domain: "paper_slot",
      subjectId: `${paper.id}:${talkMegaDeckSuffix}`,
      owner: "first_author",
      label: `Add your talk slides to ${deckPhrase(view)}`,
      detail: ADD_ONLY,
      priority,
      deadlineBearing: false,
    });
  }
  out.push({
    domain: "paper_slot",
    subjectId: `${paper.id}:${talkQuickPointersSuffix}`,
    owner: "first_author",
    label: `Add this paper to the lab's <${view.quickpointers_url}|Quick Pointers> doc${
      view.topic_label ? ` under ${view.topic_label}` : " under its topic"
    }`,
    detail: "add an entry for your work; leave everyone else's as they are",
    priority,
    deadlineBearing: false,
  });
  return out;
}
