import { describe, expect, it } from "vitest";
import type {
  AdminBotAuditEvent,
  AdminBotLabMember,
  AdminBotStoredProposal,
} from "../../contracts/actions.js";
import { memberGuideStatus } from "./guide-status.js";

const member = {
  id: "example",
  member_type: "full",
  email: "member@example.test",
  correspondence_email: "alternate@example.test",
} as AdminBotLabMember;
describe("onboarding send status", () => {
  it("distinguishes a queued draft, successful send, failed send, and a non-email member type", () => {
    const proposal = {
      id: "draft",
      status: "pending",
      created_at: "2026-01-01",
      proposed_payload: { template_id: "member", email: member.email },
    } as AdminBotStoredProposal;
    expect(memberGuideStatus(member, [], [proposal]).status).toBe("pending");
    const audit = {
      id: "audit",
      type: "onboarding.guide_sent",
      timestamp: "2026-01-02",
      details: { template_id: "member", recipient: "ALTERNATE@example.test", sent: true },
    } as AdminBotAuditEvent;
    expect(memberGuideStatus(member, [audit], [proposal])).toMatchObject({
      status: "sent",
      recorded_at: audit.timestamp,
    });
    expect(
      memberGuideStatus(member, [{ ...audit, details: { ...audit.details, sent: false } }], [])
        .status,
    ).toBe("failed");
    expect(memberGuideStatus(member, [], []).status).toBe("not_queued");
    expect(memberGuideStatus({ ...member, member_type: "external-prof" }, [], []).status).toBe(
      "not_applicable",
    );
    expect(
      memberGuideStatus(
        member,
        [{ ...audit, details: { ...audit.details, template_id: "alumni" } }],
        [],
      ).status,
    ).toBe("not_queued");
  });
});
