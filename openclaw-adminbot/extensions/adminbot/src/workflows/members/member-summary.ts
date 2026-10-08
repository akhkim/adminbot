import type { AdminBotLabMember } from "../../contracts/actions.js";
import type { AdminBotLabMemberSummary } from "../../kernel/service.js";

/**
 * The roster card projection: a member without provenance or access grants, with onboarding cut
 * to per-step `{ id, status }`. Every list read (summary view, paged list) sends this, so a
 * 1000-member roster does not ship each member's onboarding copy and audit trail.
 */
export function summarizeLabMember(member: AdminBotLabMember): AdminBotLabMemberSummary {
  const { field_provenance: _provenance, access: _access, ...summary } = member;
  if (summary.onboarding && !Array.isArray(summary.onboarding)) {
    return {
      ...summary,
      onboarding: {
        steps: Array.isArray(summary.onboarding.steps)
          ? summary.onboarding.steps.map(({ id, status }) => ({ id, status }))
          : [],
      },
    } as AdminBotLabMemberSummary;
  }
  return summary as AdminBotLabMemberSummary;
}
