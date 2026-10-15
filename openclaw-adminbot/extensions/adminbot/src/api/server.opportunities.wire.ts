import type { AdminBotOpportunityView } from "../contracts/opportunities.js";

/**
 * One board row as the Opportunities tab draws it.
 *
 * The record's bookkeeping -- who decided it and when, when it was written, the submitter's id --
 * is the review trail's, not the board's: the row shows the submitter's name, never their id, and
 * nothing on it is dated by those stamps. The sweep's notes (`discovered`, `proposed_deadline`)
 * are drawn only for a signed-in viewer, so a signed-out visitor -- the tab is public -- is not
 * sent them at all, and nobody is sent the feed name or the time the sweep looked.
 */
export type OpportunityWire = Omit<
  AdminBotOpportunityView,
  | "submitted_by_member_id"
  | "created_at"
  | "updated_at"
  | "decided_at"
  | "decided_by"
  | "discovered"
  | "proposed_deadline"
> & {
  discovered?: { source_url: string; evidence: string };
  proposed_deadline?: { deadline_aoe: string; source_url: string; evidence: string };
};

export function opportunityWire(
  opportunity: AdminBotOpportunityView,
  viewer: { signedIn: boolean },
): OpportunityWire {
  const {
    submitted_by_member_id: _submitter,
    created_at: _created,
    updated_at: _updated,
    decided_at: _decidedAt,
    decided_by: _decidedBy,
    discovered,
    proposed_deadline: proposed,
    ...row
  } = opportunity;
  if (!viewer.signedIn) {
    return row;
  }
  return {
    ...row,
    ...(discovered
      ? { discovered: { source_url: discovered.source_url, evidence: discovered.evidence } }
      : {}),
    ...(proposed
      ? {
          proposed_deadline: {
            deadline_aoe: proposed.deadline_aoe,
            source_url: proposed.source_url,
            evidence: proposed.evidence,
          },
        }
      : {}),
  };
}
