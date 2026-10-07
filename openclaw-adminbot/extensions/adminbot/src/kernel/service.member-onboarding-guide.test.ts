// Onboarding one member of the roster, which is what the Members tab's Add-member button runs
// after it has created the record. The sweep's version of this is covered next door in
// service.onboarding-sweep.test.ts; what is different here is that a person, not a cron job, has
// just asked for it -- so the refusals have to name what an admin can go and fix.
import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const add = (service: AdminBotService, member: Record<string, unknown>) =>
  unwrap(
    service.upsertLabMember({
      id: "grace",
      name: "Grace Hopper",
      email: "grace@lab.co",
      ...member,
    } as never),
  );

const filed = (service: AdminBotService) =>
  (
    service as never as {
      store: {
        listProposalsByType: (type: string) => Array<{
          type: string;
          status: string;
          summary: string;
          proposed_payload: unknown;
        }>;
      };
    }
  ).store.listProposalsByType("onboarding.send_guide");

const queue = (service: AdminBotService, memberId = "grace") =>
  service.queueOnboardingGuideForMember({ memberId, actor: "ada" });

describe("onboarding a member added from the roster", () => {
  it("queues the guide their member type calls for, for approval rather than sending", () => {
    const service = new AdminBotService();
    add(service, { member_type: "full" });
    const out = unwrap(queue(service));
    expect(out).toMatchObject({ template_id: "member", email: "grace@lab.co" });
    // The payload names the template and the recipient and carries no body: the sender composes at
    // execution time, so the copy cannot drift from the provisioning it promises.
    expect(filed(service)).toHaveLength(1);
    expect(filed(service)[0]).toMatchObject({
      type: "onboarding.send_guide",
      status: "pending",
      proposed_payload: {
        template_id: "member",
        email: "grace@lab.co",
        member_id: "grace",
      },
    });
  });

  // The most-committed token wins, the same way it does for a sheet row carrying several roles.
  it("picks the template from the most-committed role on a compound type", () => {
    const service = new AdminBotService();
    add(service, { member_type: "coauthor-minor, alumni" });
    expect(unwrap(queue(service)).template_id).toBe("alumni");
  });

  it("refuses a member with no address rather than filing a mail to nobody", () => {
    const service = new AdminBotService();
    add(service, { id: "noreach", email: "", member_type: "full" });
    const result = queue(service, "noreach");
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(filed(service)).toHaveLength(0);
  });

  // Their onboarding is the access-level algorithm granting the subgroup's items in the backend.
  // Saying so is the point: an admin who ticked the box should learn nothing is owed, not wonder.
  it("refuses a member type whose onboarding is not a mail, and says which", () => {
    const service = new AdminBotService();
    add(service, { member_type: "acquaintance" });
    const result = queue(service);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("acquaintance");
    expect(filed(service)).toHaveLength(0);
  });

  it("refuses a member with no type at all", () => {
    const service = new AdminBotService();
    add(service, {});
    expect(queue(service)).toMatchObject({ ok: false, status: 422 });
  });

  // Pressing Add member twice on the same id is the ordinary way this happens.
  it("does not queue a second copy while one is waiting for an approver", () => {
    const service = new AdminBotService();
    add(service, { member_type: "full" });
    unwrap(queue(service));
    expect(queue(service)).toMatchObject({ ok: false, status: 409 });
    expect(filed(service)).toHaveLength(1);
  });

  it("does not re-onboard somebody the guide has already reached", () => {
    const service = new AdminBotService();
    add(service, { member_type: "full" });
    service.recordOnboardingGuideSent({
      actor: "ada",
      template_id: "member",
      email: "Grace@Lab.co",
      sent: true,
    });
    expect(queue(service)).toMatchObject({ ok: false, status: 409 });
    expect(filed(service)).toHaveLength(0);
  });

  // A recorded attempt that never went out is not a send, so it must not block the retry.
  it("still queues after a send that was recorded as failed", () => {
    const service = new AdminBotService();
    add(service, { member_type: "full" });
    service.recordOnboardingGuideSent({
      actor: "ada",
      template_id: "member",
      email: "grace@lab.co",
      sent: false,
    });
    expect(unwrap(queue(service)).template_id).toBe("member");
  });

  it("refuses an id no member has", () => {
    const service = new AdminBotService();
    expect(queue(service, "nobody")).toMatchObject({ ok: false, status: 404 });
  });
});
