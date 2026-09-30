/** Member-authored deadline suggestions; delivery uses the ordinary proposal ledger. */
import { createHash } from "node:crypto";
import { adminBotIsAlumniMember, type AdminBotStoredProposal } from "../contracts/actions.js";
import { resolveAdminBotControlUiUrl } from "../contracts/control-ui.js";
import type {
  DeadlineRecommendationDirectory,
  DeadlineRecommendationQuery,
  DeadlineRecommendationInput,
  DeadlineRecommendationPayload,
  DeadlineRecommendationPreview,
} from "../contracts/deadline-recommendations.js";
import { deadlineSourceDateLabel } from "../workflows/deadlines/source-date.js";
import type { AdminBotService, AdminBotServiceStore, AdminBotServiceResponse } from "./service.js";

type Context = { service: AdminBotService; store: AdminBotServiceStore };
const actionType = "deadline.recommend";
const fail = (status: number, message: string): AdminBotServiceResponse<never> => ({
  ok: false,
  status,
  error: { message },
});
const ok = <T>(payload: T): AdminBotServiceResponse<T> => ({ ok: true, status: 200, payload });
const escapeSlack = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function fingerprint(venue: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        venue.name,
        venue.deadline_label,
        venue.deadline_at,
        venue.deadline_aoe,
        venue.deadline_date,
        venue.deadline_time_precision,
        venue.deadline_timezone,
      ]),
    )
    .digest("hex");
}
function recommendationPayload(action: AdminBotStoredProposal): DeadlineRecommendationPayload {
  return action.proposed_payload as DeadlineRecommendationPayload;
}
function view(action: AdminBotStoredProposal): DeadlineRecommendationPreview {
  const data = recommendationPayload(action);
  return {
    id: action.id,
    payload_hash: action.payload_hash,
    message: data.message,
    recommender_name: data.recommender_name,
    recipient_name: data.recipient_name,
    status: action.status === "executed" ? "sent" : "pending",
  };
}
function activeMember(ctx: Context, id: string) {
  const member = ctx.store.getLabMember(id);
  return member && !adminBotIsAlumniMember(member) ? member : undefined;
}
export function recommendationDirectory(
  ctx: Context,
  actor: string,
  query: DeadlineRecommendationQuery = {},
): AdminBotServiceResponse<DeadlineRecommendationDirectory> {
  if (!activeMember(ctx, actor)) {
    return fail(403, "An active member account is required.");
  }
  const page = {
    limit: 50,
    offset: Math.max(0, Math.floor(query.offset ?? 0)),
    q: query.q?.trim().slice(0, 100),
  };
  const memberView = (member: NonNullable<ReturnType<typeof activeMember>>) => ({
    id: member.id,
    name: member.name,
    avatar_url: member.avatar_url,
    slack_linked: Boolean(member.slack_user_id),
  });
  if (query.mode === "members") {
    const members = ctx.store.listLabMembers(page);
    return ok({
      members: members
        .filter((member) => member.id !== actor && !adminBotIsAlumniMember(member))
        .map(memberView),
      papers: [],
      recommendations: [],
      ...(members.length === page.limit ? { nextOffset: page.offset + page.limit } : {}),
    });
  }
  if (query.mode === "papers") {
    if (!query.recipient || !activeMember(ctx, query.recipient)) {
      return fail(400, "Choose an active member.");
    }
    const papers = ctx.store.listPapers({ ...page, authorMemberId: query.recipient });
    return ok({
      members: [],
      papers: papers
        .filter((paper) =>
          paper.author_links?.some((author) => author.member_id === query.recipient),
        )
        .map((paper) => ({
          id: paper.id,
          title: paper.title,
          author_member_ids: [query.recipient!],
        })),
      recommendations: [],
      ...(papers.length === page.limit ? { nextOffset: page.offset + page.limit } : {}),
    });
  }
  const ids = query.deadlineIds ? new Set(query.deadlineIds.slice(0, 250)) : undefined;
  const recommendations = ctx.store
    .listProposalsByType(actionType)
    .filter((action) => action.status === "executed")
    .map(recommendationPayload)
    .filter((data) => !ids || ids.has(data.deadline_id))
    .map((data) => ({
      deadline_id: data.deadline_id,
      recipient_member_id: data.recipient_member_id,
      recommender_member_id: data.recommender_member_id,
    }));
  const members = [...new Set(recommendations.map((row) => row.recipient_member_id))].flatMap(
    (id) => {
      const member = activeMember(ctx, id);
      return member ? [memberView(member)] : [];
    },
  );
  return ok({ members, papers: [], recommendations });
}

export function previewRecommendation(
  ctx: Context,
  actor: string,
  input: DeadlineRecommendationInput,
  deadlines: readonly unknown[],
): AdminBotServiceResponse<DeadlineRecommendationPreview> {
  const from = activeMember(ctx, actor);
  const to =
    typeof input.recipient_member_id === "string"
      ? activeMember(ctx, input.recipient_member_id)
      : undefined;
  if (!from || !to) {
    return fail(400, "Choose an active member.");
  }
  if (from.id === to.id) {
    return fail(400, "Choose another member to recommend.");
  }
  if (!from.slack_user_id || !to.slack_user_id || from.slack_user_id === to.slack_user_id) {
    return fail(400, "Both members need distinct linked Slack accounts.");
  }
  if (![from.slack_user_id, to.slack_user_id].every((id) => /^[UW][A-Z0-9]+$/u.test(id))) {
    return fail(400, "A linked Slack account is invalid.");
  }
  if (
    input.reason !== undefined &&
    (typeof input.reason !== "string" || input.reason.length > 1000)
  ) {
    return fail(400, "Keep the reason within 1,000 characters.");
  }
  const venue = deadlines.find(
    (row) =>
      row &&
      typeof row === "object" &&
      ((row as Record<string, unknown>).deadline_id ?? (row as Record<string, unknown>).id) ===
        input.deadline_id,
  ) as Record<string, unknown> | undefined;
  if (!venue || typeof venue.name !== "string") {
    return fail(404, "Deadline not found.");
  }
  if (
    input.paper_ids !== undefined &&
    (!Array.isArray(input.paper_ids) ||
      input.paper_ids.some((id) => typeof id !== "string" || !id.trim()))
  ) {
    return fail(400, "Paper IDs must be a list of non-empty strings.");
  }
  const paperIds = [...new Set(input.paper_ids ?? [])].toSorted();
  const papers = paperIds.map((id) => ctx.store.getPaper(id));
  if (
    papers.some(
      (paper) => !paper || !paper.author_links?.some((author) => author.member_id === to.id),
    )
  ) {
    return fail(400, "Every selected paper must be linked to the recommended member.");
  }
  const reason = input.reason?.trim() ?? "";
  const label = typeof venue.deadline_label === "string" ? venue.deadline_label : "Submission";
  const dateLabel = deadlineSourceDateLabel(venue);
  const lines = [
    `${escapeSlack(from.name)} recommends ${escapeSlack(to.name)} consider ${escapeSlack(venue.name)}.`,
    ...(papers.length ? [papers.map((paper) => `• ${escapeSlack(paper!.title)}`).join("\n")] : []),
    `${escapeSlack(label)}: ${escapeSlack(dateLabel)}.`,
    ...(reason ? [escapeSlack(reason)] : []),
    `${resolveAdminBotControlUiUrl().replace(/\/$/u, "")}/deadlines`,
  ];
  const data: DeadlineRecommendationPayload = {
    deadline_id: input.deadline_id,
    recommender_member_id: from.id,
    recipient_member_id: to.id,
    recommender_name: from.name,
    recipient_name: to.name,
    paper_ids: paperIds,
    reason,
    deadline_fingerprint: fingerprint(venue),
    user_ids: [from.slack_user_id, to.slack_user_id],
    message: lines.join("\n\n"),
  };
  // Changing a reason must not turn a double-click or reopened form into another notification.
  const key = `deadline-recommend:${createHash("sha256")
    .update(JSON.stringify([from.id, to.id, input.deadline_id, paperIds]))
    .digest("hex")}`;
  const existing = ctx.store
    .listProposalsByType(actionType)
    .find(
      (action) =>
        action.idempotency_key === key &&
        (action.status === "executed" ||
          JSON.stringify(action.proposed_payload) === JSON.stringify(data)),
    );
  if (existing) {
    return ok(view(existing));
  }
  const created = ctx.service.createProposal({
    type: actionType,
    summary: `${from.name} recommends ${venue.name} to ${to.name}`,
    target: { service: "slack", recipientMemberId: to.id, recommenderMemberId: from.id },
    proposed_payload: data,
    idempotency_key: key,
    undo_plan: "Send a correction in the same Slack conversation.",
  });
  return created.ok ? ok(view(created.payload)) : created;
}
export async function sendRecommendation(
  ctx: Context,
  actor: string,
  id: string,
  hash: string,
  deadlines: readonly unknown[],
): Promise<AdminBotServiceResponse<DeadlineRecommendationPreview>> {
  const action = ctx.store.getProposal(id);
  if (
    !action ||
    action.type !== actionType ||
    recommendationPayload(action).recommender_member_id !== actor
  ) {
    return fail(404, "Recommendation not found.");
  }
  if (hash !== action.payload_hash) {
    return fail(409, "The preview changed. Review it again.");
  }
  const data = recommendationPayload(action);
  const from = activeMember(ctx, actor),
    to = activeMember(ctx, data.recipient_member_id);
  if (
    !from ||
    !to ||
    from.slack_user_id !== data.user_ids[0] ||
    to.slack_user_id !== data.user_ids[1]
  ) {
    return fail(409, "The members' Slack identities changed. Create a new preview.");
  }
  const sent = ctx.store
    .listProposalsByType(actionType)
    .find(
      (other) => other.idempotency_key === action.idempotency_key && other.status === "executed",
    );
  if (sent) {
    return ok(view(sent));
  }
  const current = deadlines.find(
    (row) =>
      row &&
      typeof row === "object" &&
      ((row as Record<string, unknown>).deadline_id ?? (row as Record<string, unknown>).id) ===
        data.deadline_id,
  ) as Record<string, unknown> | undefined;
  if (!current || fingerprint(current) !== data.deadline_fingerprint) {
    return fail(409, "The deadline changed. Create a new preview before sending.");
  }
  const approved = ctx.service.approve(id, {
    payload_hash: hash,
    approver_role: "recommender",
    approver_id: actor,
  });
  if (!approved.ok) {
    return approved;
  }
  const executed = await ctx.service.execute(id, {
    dry_run: false,
    idempotency_key: action.idempotency_key,
  });
  if (!executed.ok) {
    return executed;
  }
  const delivered = ctx.store
    .listProposalsByType(actionType)
    .find(
      (other) => other.idempotency_key === action.idempotency_key && other.status === "executed",
    );
  return delivered ? ok(view(delivered)) : fail(502, "Slack delivery was not confirmed.");
}
