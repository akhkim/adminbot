import type {
  AdminBotLabMember,
  AdminBotMemberOnboarding,
  AdminBotMemberOnboardingStep,
} from "../../contracts/actions.js";
import { buildOnboardingSteps, resolveMemberOnboarding } from "./onboarding.js";

/**
 * What a member row stores for onboarding: per-step state and the cycle clock, nothing else.
 *
 * The step text (labels, details, bullets, links) is the lab's onboarding doc, the same for every
 * member and owned by `onboarding.ts`. A row that carried it spent ~12KB per member on copy, which
 * also went stale whenever the doc changed. Reads attach it again from the catalog.
 */
export type AdminBotStoredMemberOnboarding = {
  steps: Array<Pick<AdminBotMemberOnboardingStep, "id" | "status" | "acknowledged_at">>;
} & Pick<AdminBotMemberOnboarding, "opened_at" | "reason" | "last_nudged_at">;

function isChecklist(value: unknown): value is AdminBotMemberOnboarding {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { steps?: unknown }).steps)
  );
}

/** The member as it is written to a store row: onboarding cut to its stored shape. */
export function toStoredLabMember(member: AdminBotLabMember): AdminBotLabMember {
  const onboarding: unknown = member.onboarding;
  if (!isChecklist(onboarding)) {
    return member;
  }
  const stored: AdminBotStoredMemberOnboarding = {
    steps: onboarding.steps.map(({ id, status, acknowledged_at }) => ({
      id,
      status,
      ...(acknowledged_at ? { acknowledged_at } : {}),
    })),
    ...(onboarding.opened_at ? { opened_at: onboarding.opened_at } : {}),
    ...(onboarding.reason ? { reason: onboarding.reason } : {}),
    ...(onboarding.last_nudged_at ? { last_nudged_at: onboarding.last_nudged_at } : {}),
  };
  return { ...member, onboarding: stored as AdminBotMemberOnboarding };
}

/**
 * Parses stored member rows, attaching the onboarding text from the current catalog.
 *
 * Takes rows in both shapes: the slim one written now, and the legacy one that stored every step's
 * text plus `completed`/`remaining`/`current_step` copies. Either way only the per-step state is
 * kept, so a legacy row reads exactly as it would once rewritten. One reader per batch of rows, so
 * a whole roster shares a single catalog build.
 */
export function labMemberRowReader(): (payloadJson: string) => AdminBotLabMember {
  let catalog: readonly AdminBotMemberOnboardingStep[] | undefined;
  return (payloadJson) => {
    const member = JSON.parse(payloadJson) as AdminBotLabMember;
    const onboarding: unknown = member.onboarding;
    if (isChecklist(onboarding)) {
      catalog ??= buildOnboardingSteps();
      member.onboarding = resolveMemberOnboarding(onboarding, { catalog });
    }
    return member;
  };
}

/** One stored member row, for a single-row read. */
export function readLabMemberRow(payloadJson: string): AdminBotLabMember {
  return labMemberRowReader()(payloadJson);
}
