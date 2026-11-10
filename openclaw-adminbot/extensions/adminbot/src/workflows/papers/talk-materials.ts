// The two things the lab asks of a talk once a paper has gone out: put your slides into the topic's
// shared mega deck, and add the work to that topic's QuickPointers doc.
//
// Neither is a paper slot. Nobody can verify either from a link (the deck is one shared file the
// student only appends to), so there is nothing to store and nothing to validate -- they are
// reminders, said once, in the same message as whatever else the person owes on that paper.
//
// Pure. The deck and doc URLs are deployment config (ADMINBOT_TALK_MATERIALS_JSON); nothing here
// knows a real link.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  adminBotPaperSlotBranchPriority,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import { isPaperClosed, isPaperDormant, type NudgeItem } from "./paper-slots.js";

export type AdminBotTalkTopicMaterials = {
  /** How the topic reads in a message, e.g. "causality". Defaults to the config key. */
  label?: string;
  mega_deck_url?: string;
  quickpointers_url?: string;
};

export type AdminBotTalkMaterialsConfig = {
  /** Keyed by topic slug, matched against the first author's research branch. */
  topics: Record<string, AdminBotTalkTopicMaterials>;
  /** Used when the author's research branch matches no topic. */
  default_topic?: string;
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
    const deck = httpsUrl(fields.mega_deck_url);
    const pointers = httpsUrl(fields.quickpointers_url);
    topics[slug] = {
      ...(label ? { label } : {}),
      ...(deck ? { mega_deck_url: deck } : {}),
      ...(pointers ? { quickpointers_url: pointers } : {}),
    };
  }
  const fallback = text(record.default_topic)?.toLowerCase();
  return {
    topics,
    ...(fallback && topics[fallback] ? { default_topic: fallback } : {}),
  };
}

/**
 * Which configured topic a research branch belongs to: by key or label, case-insensitively, then
 * by the branch mentioning it ("causal inference" finds "causal"), then the default.
 */
export function resolveTalkTopic(
  config: AdminBotTalkMaterialsConfig,
  researchBranch: string | undefined,
): { key: string; materials: AdminBotTalkTopicMaterials } | undefined {
  const branch = (researchBranch ?? "").trim().toLowerCase();
  const entries = Object.entries(config.topics);
  if (branch) {
    const exact = entries.find(
      ([key, materials]) => key === branch || materials.label?.toLowerCase() === branch,
    );
    const loose =
      exact ??
      entries.find(
        ([key, materials]) =>
          branch.includes(key) ||
          (materials.label && branch.includes(materials.label.toLowerCase())),
      );
    if (loose) {
      return { key: loose[0], materials: loose[1] };
    }
  }
  if (config.default_topic && config.topics[config.default_topic]) {
    return { key: config.default_topic, materials: config.topics[config.default_topic] };
  }
  return undefined;
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
 * The deck and QuickPointers reminders for one paper, or nothing.
 *
 * Fires once the first submission is in or the slides slot is filled -- whichever happened
 * recently. A waived submission (grandfathered by the backfill) is not a submission event. A
 * waived slides slot means there is no talk, so the deck line is dropped; the QuickPointers line
 * still makes sense for the work itself.
 */
export function talkMaterialReminders(params: {
  paper: AdminBotPaperRecord;
  stored: AdminBotPaperSlotRecord[];
  now: Date;
  config: AdminBotTalkMaterialsConfig;
  researchBranch?: string;
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
  const topic = resolveTalkTopic(params.config, params.researchBranch);
  const name = topic ? (topic.materials.label ?? topic.key) : undefined;
  const priority = adminBotPaperSlotBranchPriority.talk;
  const out: NudgeItem[] = [];
  if (slides?.status !== "waived") {
    const deck = topic?.materials.mega_deck_url;
    out.push({
      domain: "paper_slot",
      subjectId: `${paper.id}:${talkMegaDeckSuffix}`,
      owner: "first_author",
      label: `Add your talk slides to the lab's ${name ? `${name} ` : "topic "}mega deck${
        deck ? ` (${deck})` : ""
      }`,
      detail: "add your slides only; never delete or rearrange anyone else's",
      priority,
      deadlineBearing: false,
    });
  }
  const pointers = topic?.materials.quickpointers_url;
  out.push({
    domain: "paper_slot",
    subjectId: `${paper.id}:${talkQuickPointersSuffix}`,
    owner: "first_author",
    label: `Add this work to the lab's ${name ? `${name} ` : ""}QuickPointers doc${
      pointers ? ` (${pointers})` : ""
    }`,
    priority,
    deadlineBearing: false,
  });
  return out;
}
