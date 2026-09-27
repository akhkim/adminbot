import type {
  AdminBotAuditEvent,
  AdminBotLabMember,
  AdminBotStoredProposal,
} from "../../contracts/actions.js";
import { templateForMemberType } from "./member-type-template.js";

export function memberGuideStatus(
  member: AdminBotLabMember,
  audit: readonly AdminBotAuditEvent[],
  proposals: readonly AdminBotStoredProposal[],
) {
  const template = templateForMemberType(member.member_type);
  if (!template.ok) return { status: "not_applicable", detail: template.reason };
  const emails = [member.email, member.correspondence_email, member.calendar_email]
    .map((email) => email?.trim().toLowerCase())
    .filter(Boolean);
  const matches = (payload: Record<string, unknown>) =>
    payload.template_id === template.templateId &&
    typeof payload.email === "string" &&
    emails.includes(payload.email.trim().toLowerCase());
  let attempt: AdminBotAuditEvent | undefined;
  for (const event of audit) {
    const details = event.details;
    if (
      event.type !== "onboarding.guide_sent" ||
      !details ||
      !matches({ ...details, email: details.recipient })
    )
      continue;
    const sent = details.sent === true;
    const previousSent = attempt?.details?.sent === true;
    if (
      !attempt ||
      (sent && !previousSent) ||
      (sent === previousSent && event.timestamp.localeCompare(attempt.timestamp) > 0)
    )
      attempt = event;
  }
  if (attempt?.details?.sent === true)
    return {
      status: "sent",
      template_id: template.templateId,
      recorded_at: attempt.timestamp,
      detail: "AdminBot recorded a successful send. Delivery and reading are not confirmed.",
    };
  let proposal: AdminBotStoredProposal | undefined;
  for (const row of proposals) {
    if (
      matches(row.proposed_payload as Record<string, unknown>) &&
      (!proposal || row.created_at.localeCompare(proposal.created_at) > 0)
    )
      proposal = row;
  }
  if (proposal)
    return {
      status: proposal.status,
      template_id: template.templateId,
      proposal_id: proposal.id,
      detail:
        proposal.status === "pending" || proposal.status === "approved"
          ? "Review, approve, and execute the email draft in Pending Actions. It has not been sent yet."
          : "Check the action and send audit; this action status alone does not confirm email delivery.",
    };
  return {
    status: attempt ? "failed" : "not_queued",
    template_id: template.templateId,
    detail: attempt
      ? "The last recorded attempt did not send an email."
      : "No onboarding email draft or successful send is recorded for this member type.",
  };
}
