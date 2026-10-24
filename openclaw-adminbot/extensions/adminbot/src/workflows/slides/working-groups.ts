import { createHash } from "node:crypto";
import { isSlackDefaultAvatar } from "../members/slack-avatar.js";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  isThemeMeetingEligible,
  memberThemeIds,
  type ResearchThemeId,
} from "../members/research-themes.js";

export type WorkingGroupBox = {
  /** Short and stable: it is baked into every face objectId this sync creates. */
  key: string;
  /** The text in the box's heading on the slide, matched case- and dash-insensitively. */
  title: string;
  /** The research theme whose members belong in the box, or null when no theme covers it. */
  theme: ResearchThemeId | null;
  /**
   * Whole phrases that also put a member in the box when one appears in their research topics or
   * projects. Slides-only: the theme classifier and the #meeting channels never see them, so a box
   * can be filled without inventing a meeting theme. A box with neither a theme nor keywords is
   * measured but left as it is.
   */
  keywords?: readonly string[];
};

export const DEFAULT_WORKING_GROUPS_SLIDE_TITLE = "Scaling to 50-100 Technical Members";

export const WORKING_GROUP_BOXES: readonly WorkingGroupBox[] = [
  { key: "interp", title: "Interpretability", theme: "mech_interp" },
  // The roster has no Power Concentration theme, and adding one would add a meeting channel.
  // Phrases rather than a bare "power", which would match "ML powered causality".
  {
    key: "power",
    title: "Power Concentration",
    theme: null,
    keywords: ["power concentration", "concentration of power", "ai governance", "ai and democracy"],
  },
  { key: "adversarial", title: "Adversarial Defense", theme: "adversarial_defense" },
  { key: "multiagent", title: "Multi-Agent", theme: "multi_agent" },
  { key: "control", title: "Loss of Control", theme: "loss_of_control" },
  { key: "causality", title: "Causality", theme: "causal_llm" },
];

export const FACE_ID_PREFIX = "adminbot_face_";

const HASH_LENGTH = 12;

function memberHash(memberId: string): string {
  return createHash("sha1").update(memberId).digest("hex").slice(0, HASH_LENGTH);
}

/**
 * The objectId of the face this sync creates for a member in a group.
 *
 * Hashed rather than the member id itself: Slides objectIds are capped at 50 characters and a
 * restricted alphabet, and member ids are neither. The group is in the id so the same person can
 * sit in two boxes without a collision, and so a face dragged into the wrong box is still known.
 */
export function faceObjectId(groupKey: string, memberId: string): string {
  return `${FACE_ID_PREFIX}${groupKey}_${memberHash(memberId)}`;
}

export type ParsedFaceId = { groupKey: string; hash: string };

export function parseFaceObjectId(objectId: string): ParsedFaceId | null {
  if (!objectId.startsWith(FACE_ID_PREFIX)) {
    return null;
  }
  const match = /^([a-z]+)_([0-9a-f]{12})$/u.exec(objectId.slice(FACE_ID_PREFIX.length));
  return match ? { groupKey: match[1]!, hash: match[2]! } : null;
}

/** Hash → member id for every roster member, including alumni, so a leaver's face is still named. */
export function memberIdsByFaceHash(members: readonly AdminBotLabMember[]): Map<string, string> {
  return new Map(members.map((member) => [memberHash(member.id), member.id]));
}

/** Lower-case words separated by single spaces, so a phrase can only match whole words. */
function phraseText(value: string): string {
  return ` ${value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/** Whether any of the phrases appears, as whole words, in the member's topics or projects. */
export function matchesKeywords(member: AdminBotLabMember, keywords: readonly string[]): boolean {
  const phrases = keywords.map(phraseText).filter((phrase) => phrase.trim());
  if (!phrases.length) {
    return false;
  }
  return [...(member.research_topics ?? []), ...(member.projects ?? [])]
    .map(phraseText)
    .some((text) => phrases.some((phrase) => text.includes(phrase)));
}

/** Whether the box has any rule that says who belongs in it. */
export function hasMembershipRule(box: WorkingGroupBox): boolean {
  return Boolean(box.theme) || Boolean(box.keywords?.length);
}

/**
 * Who belongs in a box: the people the theme meetings are for, whose theme is the box's theme or
 * whose topics name one of its phrases. The theme half is the rule the #meeting-xxx channels use,
 * so the slide never claims somebody the meeting would not invite.
 *
 * Themes rather than meeting attendance. Attendance is only filed when an administrator uploads
 * a Zoom export, so it is sparse and lags by weeks; a member who said what they work on is in the
 * group from the day they said it.
 */
export function workingGroupMembers(
  members: readonly AdminBotLabMember[],
  box: Pick<WorkingGroupBox, "theme" | "keywords">,
): AdminBotLabMember[] {
  return members.filter(
    (member) =>
      isThemeMeetingEligible(member) &&
      ((box.theme !== null && memberThemeIds(member).includes(box.theme)) ||
        matchesKeywords(member, box.keywords ?? [])),
  );
}

/** A real uploaded photo: an http(s) URL that is not Slack's default silhouette. */
export function hasFacePhoto(member: AdminBotLabMember): boolean {
  const url = member.avatar_url?.trim() ?? "";
  return /^https?:\/\//u.test(url) && !isSlackDefaultAvatar(url);
}

export function normalizeSlideText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐-―-]+/gu, "-")
    .replace(/\s*-\s*/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Alt-text marker on every face this sync places. It is the only thing that makes an image ours:
 * a face without it was placed by hand and is never moved or deleted, whoever it shows.
 */
export const FACE_OWNER_PREFIX = "adminbot:member:";

export function faceOwnerTag(memberId: string): string {
  return `${FACE_OWNER_PREFIX}${memberId}`;
}

export function parseFaceOwnerTag(description: string | undefined): string | null {
  const value = description?.trim() ?? "";
  return value.startsWith(FACE_OWNER_PREFIX) ? value.slice(FACE_OWNER_PREFIX.length).trim() || null : null;
}
