// Approving, executing, and withdrawing pending actions.
//
// Controller for this zone: loads through api/governance.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import {
  approveActionAsMember,
  executeActionAsMember,
  removePendingAction,
} from "../api/governance.ts";
import { loadStoredMemberSession } from "../auth/session.ts";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  type AdminBotActionProposal,
  type AdminBotHost,
  loadAdminBot,
  requirePrivilegedSession,
} from "./admin.ts";

function approvalFailureMessage(kind: string): string {
  if (kind === "unreachable") {
    return ADMINBOT_SERVICE_UNREACHABLE_MESSAGE;
  }
  if (kind === "forbidden") {
    return "Your session no longer has approval rights — sign in again and retry.";
  }
  if (kind === "rate-limited") {
    return "Too many attempts. Wait a moment and try again.";
  }
  return "Couldn't record this approval. Reload the pending list and try again.";
}

/**
 * Why an approved action did not run.
 *
 * Separate from `approvalFailureMessage` because by this point the approval *is* recorded: saying
 * "Couldn't record this approval" sent operators to approve again, which only records a duplicate
 * and hits the same refusal. The service's own sentence is the diagnosis -- a protected cell, an
 * expired Google token -- so it is shown whenever there is one.
 */
function executionFailureMessage(
  failure: { kind: string; message?: string },
  prefix: string,
): string {
  if (
    failure.kind === "unreachable" ||
    failure.kind === "forbidden" ||
    failure.kind === "rate-limited"
  ) {
    return approvalFailureMessage(failure.kind);
  }
  return failure.message
    ? `${prefix}: ${failure.message}`
    : `${prefix}. Reload the pending list and try again.`;
}

export async function approveAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  let sessionToken: string | undefined;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    sessionToken = session.sessionToken;
    const approved = await approveActionAsMember(
      proposal.id,
      proposal.payload_hash,
      session.sessionToken,
      session.baseUrl,
    );
    if (loadStoredMemberSession()?.sessionToken !== sessionToken) {
      return;
    }
    if (!approved.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(approved.kind) };
      return;
    }
    // High-risk actions need a second distinct approver; stop here rather than executing an
    // action that is still pending quorum.
    if (approved.value.status !== "approved") {
      const need = approved.value.approval_requirement.min_approvals;
      const have = new Set(
        approved.value.approvals.map((entry) => entry.approver_id ?? entry.approver_role),
      ).size;
      host.adminBotNotice = {
        kind: "success",
        text: `Recorded your approval of ${proposal.id}. ${have} of ${need} approvals — another admin or core member must approve before it runs.`,
      };
      await loadAdminBot(host);
      return;
    }
    const executed = await executeActionAsMember(
      proposal.id,
      `control-ui-${proposal.id}`,
      session.sessionToken,
      session.baseUrl,
    );
    if (loadStoredMemberSession()?.sessionToken !== sessionToken) {
      return;
    }
    if (!executed.ok) {
      host.adminBotNotice = {
        kind: "error",
        text: executionFailureMessage(executed, `Approved ${proposal.id}, but it did not run`),
      };
      // The proposal is now approved rather than pending; reload so the row says so.
      await loadAdminBot(host);
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: `${executed.value.status === "executed" ? "Approved and executed" : "Approved and simulated"} ${proposal.id}.`,
    };
    await loadAdminBot(host);
  } finally {
    if (!sessionToken || loadStoredMemberSession()?.sessionToken === sessionToken) {
      host.adminBotBusyActionId = null;
    }
  }
}

export async function removePendingAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  let sessionToken: string | undefined;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    sessionToken = session.sessionToken;
    const removed = await removePendingAction(proposal.id, session.sessionToken, session.baseUrl);
    if (loadStoredMemberSession()?.sessionToken !== sessionToken) {
      return;
    }
    if (!removed.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(removed.kind) };
      return;
    }
    host.adminBotNotice = { kind: "success", text: "Removed " + proposal.id + "." };
    await loadAdminBot(host);
  } finally {
    if (!sessionToken || loadStoredMemberSession()?.sessionToken === sessionToken) {
      host.adminBotBusyActionId = null;
    }
  }
}

/**
 * Clears every ticked proposal.
 *
 * Removing is the only thing this screen offers in bulk, and the asymmetry is deliberate:
 * removing a proposal discards AdminBot's *suggestion* and reaches nothing outside the broker --
 * the same proposal can be raised again on the next sweep -- whereas executing one sends the mail
 * or writes the sheet. A "clear these twelve" button is a tidy-up; a "run these twelve" button is
 * twelve irreversible external effects behind one click, so executing stays one row at a time.
 *
 * One call per proposal, in sequence rather than with Promise.all: the broker rejects each
 * removal on its own terms (a proposal somebody else already executed, a session that lost its
 * privilege mid-run), and a sequential loop is what lets a single refusal be reported against the
 * row that earned it instead of failing the whole batch. The list is only reloaded once, at the
 * end, so a twelve-row clear does not repaint twelve times.
 */
export async function removeSelectedPendingAdminBotActions(host: AdminBotHost): Promise<void> {
  if (host.adminBotBulkActionBusy || host.adminBotSelectedActionIds.length === 0) {
    return;
  }
  host.adminBotBulkActionBusy = true;
  host.adminBotNotice = null;
  let sessionToken: string | undefined;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    sessionToken = session.sessionToken;
    // Only ids still on the board. A selection can outlive the row it points at -- somebody else
    // executed or removed it between the tick and the press -- and asking the service to remove a
    // proposal that is already gone reports a failure for work that is, in fact, done.
    const live = new Set(host.adminBotData.proposals.map((proposal) => proposal.id));
    const targets = host.adminBotSelectedActionIds.filter((id) => live.has(id));
    if (targets.length === 0) {
      host.adminBotSelectedActionIds = [];
      host.adminBotNotice = {
        kind: "success",
        text: "Those pending actions were already gone; the list has been refreshed.",
      };
      await loadAdminBot(host);
      return;
    }
    const failed: string[] = [];
    let firstFailure: string | undefined;
    let removed = 0;
    for (const id of targets) {
      if (loadStoredMemberSession()?.sessionToken !== sessionToken) {
        return;
      }
      const result = await removePendingAction(id, session.sessionToken, session.baseUrl);
      if (loadStoredMemberSession()?.sessionToken !== sessionToken) {
        return;
      }
      if (result.ok) {
        removed += 1;
      } else {
        failed.push(id);
        firstFailure ??= approvalFailureMessage(result.kind);
      }
    }
    // The ones that did not go stay ticked, so the retry is the same button rather than a hunt
    // through the reloaded list for which rows are still there.
    host.adminBotSelectedActionIds = failed;
    const plural = removed === 1 ? "" : "s";
    host.adminBotNotice = failed.length
      ? {
          kind: "error",
          text: `Removed ${removed} of ${targets.length} pending actions; ${failed.length} left in place. ${firstFailure ?? ""}`.trim(),
        }
      : { kind: "success", text: `Removed ${removed} pending action${plural}.` };
    await loadAdminBot(host);
  } finally {
    if (!sessionToken || loadStoredMemberSession()?.sessionToken === sessionToken) {
      host.adminBotBulkActionBusy = false;
    }
  }
}

export async function executeAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  let sessionToken: string | undefined;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    sessionToken = session.sessionToken;
    const executed = await executeActionAsMember(
      proposal.id,
      `control-ui-${proposal.id}`,
      session.sessionToken,
      session.baseUrl,
    );
    if (loadStoredMemberSession()?.sessionToken !== sessionToken) {
      return;
    }
    if (!executed.ok) {
      host.adminBotNotice = {
        kind: "error",
        text: executionFailureMessage(executed, `${proposal.id} did not run`),
      };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: `${executed.value.status === "executed" ? "Executed" : "Simulated"} ${proposal.id}.`,
    };
    await loadAdminBot(host);
  } finally {
    if (!sessionToken || loadStoredMemberSession()?.sessionToken === sessionToken) {
      host.adminBotBusyActionId = null;
    }
  }
}
