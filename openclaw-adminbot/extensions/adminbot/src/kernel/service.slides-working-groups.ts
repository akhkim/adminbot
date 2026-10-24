import { createHash } from "node:crypto";
import type {
  AdminBotExecutionResult,
  AdminBotLabMember,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import {
  EMU_PER_INCH,
  type AdminBotSlidesWorkingGroupsPayload,
  type SlidesWorkingGroupsSource,
} from "../contracts/google-slides.js";
import { isThemeMeetingEligible } from "../workflows/members/research-themes.js";
import { findSlideByTitle, measureWorkingGroupsSlide } from "../workflows/slides/face-layout-measure.js";
import { planWorkingGroupsSlide, type WorkingGroupsPlan } from "../workflows/slides/face-layout-plan.js";
import { buildFaceRequests } from "../workflows/slides/face-layout-requests.js";
import { WORKING_GROUP_BOXES, workingGroupMembers } from "../workflows/slides/working-groups.js";
import type { AdminBotService, AdminBotServiceStore } from "./service.js";

export type SlidesWorkingGroupsPreview = {
  presentation_id: string;
  slide_object_id: string;
  page: { width: number; height: number };
  plan: WorkingGroupsPlan;
  payload: AdminBotSlidesWorkingGroupsPayload;
};

export type SlidesWorkingGroupsSyncResult = {
  changed: boolean;
  /** The proposal awaiting an admin, when there is a change to make. */
  proposal?: AdminBotStoredProposal;
  /** True when an identical pending proposal already existed and was returned instead. */
  reused: boolean;
  /** Older pending proposals this run replaced, so only one plan for the slide is ever open. */
  superseded: string[];
  groups: AdminBotSlidesWorkingGroupsPayload["groups"];
  /** Set when auto-apply approved and wrote the plan in the same run. */
  applied?: AdminBotExecutionResult;
};

const IDEMPOTENCY_PREFIX = "slides-working-groups:";

/** Reads the deck, measures the slide and plans it. No writes, no proposals. */
export async function planSlidesWorkingGroups(
  store: Pick<AdminBotServiceStore, "listLabMembers">,
  source: SlidesWorkingGroupsSource,
): Promise<SlidesWorkingGroupsPreview> {
  const presentation = await source.client.getPresentation(source.presentationId);
  const found = findSlideByTitle(presentation, source.slideTitle);
  if (!found.ok) {
    throw new Error(found.reason);
  }
  const plan = planWorkingGroupsSlide({
    slideObjectId: found.slide.objectId,
    measured: measureWorkingGroupsSlide(found.slide, WORKING_GROUP_BOXES),
    members: store.listLabMembers(),
    ...(source.allowRemovals ? { allowRemovals: true } : {}),
  });
  const width = presentation.pageSize?.width?.magnitude ?? 10 * EMU_PER_INCH;
  const height = presentation.pageSize?.height?.magnitude ?? 5.625 * EMU_PER_INCH;
  return {
    presentation_id: source.presentationId,
    slide_object_id: found.slide.objectId,
    page: { width, height },
    plan,
    payload: buildFaceRequests(plan, source.presentationId),
  };
}

function summarize(payload: AdminBotSlidesWorkingGroupsPayload): string {
  const changed = payload.groups.filter((group) => group.status === "update");
  const parts = changed.map((group) => {
    const bits = [
      group.added.length ? `+${group.added.length}` : "",
      group.removed.length ? `-${group.removed.length}` : "",

    ].filter(Boolean);
    return `${group.title} (${bits.join(", ")})`;
  });
  return `Update the working-groups slide: ${parts.join("; ")}`;
}

/**
 * Plans the slide and leaves at most one proposal open for it.
 *
 * Every run supersedes the previous open plan rather than adding another: two cards for the same
 * slide, planned against different states of it, would let an admin approve the stale one. A run
 * that plans exactly the requests already waiting returns that card untouched, so the weekly job
 * and a burst of profile saves do not churn the approval queue.
 */
export async function proposeSlidesWorkingGroups(
  service: AdminBotService,
  store: Pick<AdminBotServiceStore, "listLabMembers" | "listProposalsByType">,
  source: SlidesWorkingGroupsSource,
  actor: string | undefined,
): Promise<SlidesWorkingGroupsSyncResult> {
  const preview = await planSlidesWorkingGroups(store, source);
  const { payload } = preview;
  const open = store
    .listProposalsByType("slides.sync_working_groups")
    .filter((proposal) => proposal.status === "pending" || proposal.status === "approved");
  const key = `${IDEMPOTENCY_PREFIX}${createHash("sha256")
    .update(JSON.stringify(payload.requests))
    .digest("hex")
    .slice(0, 24)}`;
  const same = payload.requests.length
    ? open.find((proposal) => proposal.idempotency_key === key)
    : undefined;
  const superseded: string[] = [];
  for (const proposal of open) {
    if (proposal === same) {
      continue;
    }
    const removed = service.removePending(proposal.id, {
      ...(actor ? { actor } : {}),
      note: payload.requests.length
        ? "Superseded by a newer plan for the working-groups slide"
        : "The working-groups slide already matches the roster",
    });
    if (removed.ok) {
      superseded.push(proposal.id);
    }
  }
  if (!payload.requests.length) {
    return { changed: false, reused: false, superseded, groups: payload.groups };
  }
  if (same) {
    const applied = await autoApply(service, source, same, payload);
    return { changed: true, proposal: same, reused: true, superseded, groups: payload.groups, ...applied };
  }
  const created = service.createProposal({
    type: "slides.sync_working_groups",
    summary: summarize(payload),
    target: {
      service: "google_slides",
      target: preview.presentation_id,
      slide: preview.slide_object_id,
    },
    proposed_payload: payload,
    rationale:
      "Group membership comes from each member's research topics and projects (the theme-meeting " +
      "rule, plus each box's slides-only keyword phrases). New round faces are appended after the " +
      "last face in each box at the measured size and spacing; no existing image is moved, and " +
      "only faces AdminBot placed can be removed, and only when removals are switched on.",
    undo_plan:
      "Restore the slide from Google Slides version history (File > Version history). Faces " +
      "AdminBot added have ids starting adminbot_face_ and alt text adminbot:member:<id>, and can " +
      "be deleted by hand.",
    idempotency_key: key,
  });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return {
    changed: true,
    proposal: created.payload,
    reused: false,
    superseded,
    groups: payload.groups,
    ...(await autoApply(service, source, created.payload, payload)),
  };
}

export const SLIDES_AUTO_APPROVER = "adminbot:slides-auto-apply";

/**
 * With auto-apply on, approve and write an append-only plan straight away. A plan that deletes
 * anything is left pending for an admin. A failed write throws, so the run is audited as failed and
 * the weekly job exits non-zero; the approved proposal stays open, and the next run re-plans
 * against the slide as it then is (the executor re-reads the deck before every write).
 */
async function autoApply(
  service: AdminBotService,
  source: SlidesWorkingGroupsSource,
  proposal: AdminBotStoredProposal,
  payload: AdminBotSlidesWorkingGroupsPayload,
): Promise<{ applied?: AdminBotExecutionResult }> {
  if (!source.autoApply || payload.requests.some((request) => "deleteObject" in request)) {
    return {};
  }
  const approved = service.approve(proposal.id, {
    payload_hash: proposal.payload_hash,
    approver_role: "admin",
    approver_id: SLIDES_AUTO_APPROVER,
    note: "Append-only working-groups plan, applied automatically (ADMINBOT_SLIDES_AUTO_APPLY=1)",
  });
  if (!approved.ok) {
    throw new Error(`auto-apply could not approve ${proposal.id}: ${approved.error.message}`);
  }
  const executed = await service.execute(proposal.id, { dry_run: false });
  if (!executed.ok) {
    throw new Error(`auto-apply could not write ${proposal.id}: ${executed.error.message}`);
  }
  return { applied: executed.payload };
}

/**
 * Whether a profile write could change the slide: a new eligible member, or a change to someone's
 * eligibility, which boxes they belong in (themes or keyword phrases), name or photo. Anything else -- a phone number, a timezone -- is not worth
 * reading the deck for.
 */
export function affectsWorkingGroupsSlide(
  existing: AdminBotLabMember | undefined,
  stored: AdminBotLabMember,
): boolean {
  const shape = (member: AdminBotLabMember | undefined) =>
    member
      ? JSON.stringify([
          isThemeMeetingEligible(member),
          WORKING_GROUP_BOXES.filter((box) => workingGroupMembers([member], box).length).map((box) => box.key),
          member.avatar_url ?? "",
          member.name,
          member.preferred_name ?? "",
        ])
      : JSON.stringify([false, [], "", "", ""]);
  if (!existing && !isThemeMeetingEligible(stored)) {
    return false;
  }
  return shape(existing) !== shape(stored);
}
