import type { AdminBotLabMember, AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotService, AdminBotServiceResponse } from "../kernel/service.js";
import type { AdminBotOnboardingSender } from "../workflows/onboarding/guide-sender.js";
import { readInterviewInvitation, interviewBody } from "../workflows/onboarding/interview.js";

/** Preview and queue share the same payload; neither provisions or sends anything. */
export async function prepareInterviewInvitation(
  service: AdminBotService,
  body: Record<string, unknown>,
  proposer: AdminBotLabMember,
  sender: AdminBotOnboardingSender,
  proposals: () => AdminBotStoredProposal[],
): Promise<AdminBotServiceResponse<unknown>> {
  const roster = service.listLabMembers();
  if (!roster.ok) {
    return roster;
  }
  try {
    const interview = readInterviewInvitation(body.interview);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (
      !name ||
      name.length > 200 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
      email.length > 254
    ) {
      throw new Error("Enter the candidate's name and valid email.");
    }
    const interviewers = interview.interviewer_ids.map((id) =>
      roster.payload.members.find((member) => member.slack_user_id === id),
    );
    if (
      interviewers.some(
        (member) => !member || !["member", "admin"].includes(member.privilege_level),
      )
    ) {
      throw new Error("Choose two current lab interviewers.");
    }
    if (
      interviewers.some(
        (member) => !member?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(member.email),
      )
    ) {
      throw new Error(
        "Both interviewers need a valid email on their lab profile so they can receive the task.",
      );
    }
    if (interviewers.some((member) => member!.email!.toLowerCase() === email.toLowerCase())) {
      throw new Error("The candidate must be different from the interviewers.");
    }
    const payload = {
      template_id: "interviewee",
      name,
      email,
      interview,
      cc: interviewers.map((member) => member!.email!),
      reply_to: interviewers[0]!.email!,
      subject_override: `Interview task: ${interview.project}`,
      body_override: interviewBody(interview.task),
      values: {
        project_or_context: interview.project,
        interviewer_names: interviewers.map((member) => member!.name).join(" and "),
        sender_name: proposer.name,
      },
    };
    const preview = await sender({ ...payload, preview: true });
    if (!preview.ok) {
      return { ok: false, status: preview.error.status, error: preview.error };
    }
    if (body.preview === true) {
      return {
        ok: true,
        status: 200,
        payload: { ...preview.payload, email, cc: payload.cc, reply_to: payload.reply_to },
      };
    }
    const duplicate = proposals().find(
      (proposal) =>
        ["pending", "approved", "executed"].includes(proposal.status) &&
        (
          proposal.proposed_payload as { email?: string; interview?: unknown }
        )?.email?.toLowerCase() === email.toLowerCase() &&
        Boolean((proposal.proposed_payload as { interview?: unknown })?.interview),
    );
    if (duplicate) {
      return {
        ok: false,
        status: 409,
        error: { message: `An interview invitation is already queued or sent (${duplicate.id}).` },
      };
    }
    return service.createProposal({
      type: "onboarding.send_guide",
      summary: `Interview invitation for ${name}: ${interview.project}`,
      target: { service: "google", channel: "email", target: email },
      proposed_payload: payload,
      undo_plan: "Email and Slack invitations cannot be recalled; follow up with the candidate.",
    });
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: { message: error instanceof Error ? error.message : "Invalid interview invitation." },
    };
  }
}
