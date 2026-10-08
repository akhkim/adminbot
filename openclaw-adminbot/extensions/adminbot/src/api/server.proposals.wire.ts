import type { AdminBotStoredProposal } from "../contracts/actions.js";

/**
 * One row of the approval queue as the queue draws it.
 *
 * The stored proposal carries the full payload it will execute -- a whole email body, a sheet
 * write, a recipient list -- plus the rationale, evidence and undo plan. The queue shows a risk
 * pill, the summary, the gate count, a time and the hash, and approving needs only the id and the
 * hash. A caller that wants the payload still gets it by leaving `view` off.
 */
export type ProposalSummaryWire = Pick<
  AdminBotStoredProposal,
  | "id"
  | "type"
  | "risk_tier"
  | "summary"
  | "status"
  | "payload_hash"
  | "approval_requirement"
  | "created_at"
  | "updated_at"
> & {
  approvals: Array<{ approver_role: string; approver_id?: string }>;
};

export function proposalSummaryWire(proposal: AdminBotStoredProposal): ProposalSummaryWire {
  return {
    id: proposal.id,
    type: proposal.type,
    risk_tier: proposal.risk_tier,
    summary: proposal.summary,
    status: proposal.status,
    payload_hash: proposal.payload_hash,
    approval_requirement: proposal.approval_requirement,
    // Counted against `min_approvals` on the page; who approved is kept so a reviewer can still be
    // told they already said yes, but the per-approval hash and note are the audit log's business.
    approvals: proposal.approvals.map((approval) => ({
      approver_role: approval.approver_role,
      ...(approval.approver_id ? { approver_id: approval.approver_id } : {}),
    })),
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
  };
}
