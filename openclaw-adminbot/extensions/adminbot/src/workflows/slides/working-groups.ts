import { createHash } from "node:crypto";
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
  /**
   * The research theme whose members fill the box. Null leaves the box measured but untouched:
   * there is no data to fill it from, and an empty guess would delete faces somebody placed.
   */
  theme: ResearchThemeId | null;
};

export const DEFAULT_WORKING_GROUPS_SLIDE_TITLE = "Scaling to 50-100 Technical Members";

export const WORKING_GROUP_BOXES: readonly WorkingGroupBox[] = [
  { key: "interp", title: "Interpretability", theme: "mech_interp" },
  // The roster has no Power Concentration theme: the classifier folds "power concentration" into
  // loss_of_control (see research-themes.ts). Giving this box the same members as Loss of Control
  // would be a claim nobody made, so it stays hand-maintained until a theme exists.
  { key: "power", title: "Power Concentration", theme: null },
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

/**
 * Who belongs in a box: the same rule the theme meetings use, so the slide and the
 * #meeting-xxx channels never disagree about who is in a group.
 *
 * Themes rather than meeting attendance. Attendance is only filed when an administrator uploads
 * a Zoom export, so it is sparse and lags by weeks; a member who said what they work on is in the
 * group from the day they said it.
 */
export function workingGroupMembers(
  members: readonly AdminBotLabMember[],
  theme: ResearchThemeId,
): AdminBotLabMember[] {
  return members.filter(
    (member) => isThemeMeetingEligible(member) && memberThemeIds(member).includes(theme),
  );
}

export function hasFacePhoto(member: AdminBotLabMember): boolean {
  return /^https?:\/\//u.test(member.avatar_url?.trim() ?? "");
}

export function normalizeSlideText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐-―-]+/gu, "-")
    .replace(/\s*-\s*/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}
