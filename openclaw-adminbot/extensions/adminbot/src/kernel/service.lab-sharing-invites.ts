import { createHash } from "node:crypto";
import type {
  AdminBotActionProposal,
  AdminBotLabMember,
  AdminBotPaperRecord,
} from "../contracts/actions.js";
import type { AdminBotService, AdminBotServiceStore } from "./service.js";

const fail = (status: number, message: string) => ({
  ok: false as const,
  status,
  error: { message },
});
type OwnsPaper = (member: AdminBotLabMember, paper: AdminBotPaperRecord) => boolean;

/** Creates approval-bound proposals only. Recipient addresses never enter member responses. */
export class LabSharingInvites {
  constructor(
    private store: AdminBotServiceStore,
    private ownsPaper: OwnsPaper,
    private propose: AdminBotService["createProposal"],
  ) {}
  list(actorId: string) {
    if (!this.store.getLabMember(actorId)) {
      return fail(403, "A member session is required.");
    }
    const invites = (["email.send", "calendar.send_invite"] as const)
      .flatMap((type) => this.store.listProposalsByType(type))
      .filter((row) => row.target?.lab_sharing_invite === true && row.target.actor_id === actorId)
      .map((row) => ({
        id: row.id,
        status: row.status,
        kind: row.type === "email.send" ? "collaboration" : "call",
        project_title: this.store.getPaper(String(row.target?.paper_id))?.title ?? "Project",
        recipient_name:
          this.store.getLabMember(String(row.target?.recipient_id))?.name ?? "Lab member",
        created_at: row.created_at,
      }))
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at));
    return { ok: true as const, status: 200, payload: { invites } };
  }
  request(actorId: string, input: unknown) {
    const actor = this.store.getLabMember(actorId);
    if (!actor) {
      return fail(403, "A member session is required.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return fail(400, "Provide an invitation request.");
    }
    const body = input as Record<string, unknown>;
    const paper =
      typeof body.paper_id === "string" ? this.store.getPaper(body.paper_id) : undefined;
    if (!paper || !(actor.privilege_level === "admin" || this.ownsPaper(actor, paper))) {
      return fail(403, "Choose a project you manage.");
    }
    if (
      !this.store
        .listHelpRequests()
        .some((row) => row.paper_id === paper.id && row.status === "open")
    ) {
      return fail(409, "Open the project's help request before inviting members.");
    }
    const recipient =
      typeof body.recipient_id === "string"
        ? this.store.getLabMember(body.recipient_id)
        : undefined;
    if (!recipient || recipient.id === actorId) {
      return fail(400, "Choose another lab member.");
    }
    if (typeof body.note !== "string" || !body.note.trim() || body.note.trim().length > 1000) {
      return fail(400, "Use a note of 1 to 1000 characters.");
    }
    if (body.kind !== "collaboration" && body.kind !== "call") {
      return fail(400, "Choose collaboration or call.");
    }
    const address =
      body.kind === "call" ? recipient.calendar_email || recipient.email : recipient.email;
    const sender = body.kind === "call" ? actor.calendar_email || actor.email : actor.email;
    if (!address?.trim() || !sender?.trim()) {
      return fail(400, "The members need contact details on their profiles.");
    }
    const note = body.note.trim();
    let proposed_payload: Record<string, unknown>;
    if (body.kind === "call") {
      const valid = (value: unknown) =>
        typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
      if (!valid(body.start) || !valid(body.end)) {
        return fail(400, "Provide call start and end in UTC.");
      }
      const start = Date.parse(body.start as string),
        end = Date.parse(body.end as string);
      if (start <= Date.now() || end <= start || end - start > 8 * 60 * 60 * 1000) {
        return fail(400, "Choose a future call lasting at most eight hours.");
      }
      proposed_payload = {
        summary: `Project discussion: ${paper.title}`,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        timezone: "UTC",
        attendees: [...new Set([sender, address])],
        description: `Requested by ${actor.name}.\n\n${note}`,
      };
    } else {
      proposed_payload = {
        to: address,
        reply_to: sender,
        subject: `Collaboration invitation: ${paper.title}`,
        body: `${actor.name} invites you to discuss collaborating on ${paper.title}.\n\n${note}\n\nReply to this email to contact ${actor.name}.`,
      };
    }
    const type = body.kind === "call" ? "calendar.send_invite" : "email.send";
    const target = {
      lab_sharing_invite: true,
      actor_id: actorId,
      paper_id: paper.id,
      recipient_id: recipient.id,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify({ type, target, proposed_payload }))
      .digest("hex");
    const key = `lab-sharing-invite:${digest}`;
    const previous = this.store
      .listProposalsByType(type)
      .find((row) => row.idempotency_key === key);
    if (previous) {
      return {
        ok: true as const,
        status: 200,
        payload: { id: previous.id, status: previous.status },
      };
    }
    const proposal: AdminBotActionProposal = {
      type,
      summary: `${actor.name}: invite ${recipient.name} to ${paper.title}`,
      target,
      proposed_payload,
      idempotency_key: key,
      rationale:
        "Requested from Lab Sharing. An administrator must review the exact recipient and content before execution.",
    };
    const result = this.propose(proposal);
    return result.ok
      ? {
          ok: true as const,
          status: 200,
          payload: { id: result.payload.id, status: result.payload.status },
        }
      : result;
  }
}
