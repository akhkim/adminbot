// The Announcements send notice: the portal and the channel are counted apart (issue #536).
import { describe, expect, it } from "vitest";
import { describeMemberNudgeResult } from "./nudges.ts";

const ids = Array.from({ length: 10 }, (_, index) => `m${index}`);

describe("describeMemberNudgeResult", () => {
  it("does not call ten portal notifications ten Slack sends", () => {
    const notice = describeMemberNudgeResult(
      {
        created: [
          { id: "a0", status: "executed" },
          { id: "a1", status: "executed" },
        ],
        skipped: ids.slice(2).map((id) => ({ member_id: id, reason: "slack: request timed out" })),
        portal_notified: ids,
        deliveries: ids.map((id, index) =>
          index < 2
            ? { member_id: id, action_id: `a${index}`, outcome: "executed" as const }
            : {
                member_id: id,
                action_id: `a${index}`,
                outcome: "unknown" as const,
                reason: "slack: request timed out",
              },
        ),
      },
      "slack",
    );
    expect(notice).toEqual({
      kind: "error",
      text:
        "Sent 2 on Slack. 10 members notified in the portal. " +
        "8 with an unknown outcome: check before sending again.",
    });
  });

  it("names refusals, declined sends and skips under their own counts", () => {
    const notice = describeMemberNudgeResult(
      {
        created: [
          { id: "a-sent", status: "executed" },
          { id: "a-held", status: "approved" },
        ],
        skipped: [
          { member_id: "no-slack", reason: "member has no slack_user_id" },
          { member_id: "refused", reason: "no live connector is configured" },
        ],
        portal_notified: ["sent", "held", "no-slack", "refused"],
        deliveries: [
          { member_id: "sent", action_id: "a-sent", outcome: "executed" },
          { member_id: "held", action_id: "a-held", outcome: "not_delivered" },
          {
            member_id: "refused",
            action_id: "a-refused",
            outcome: "failed",
            reason: "no live connector is configured",
          },
        ],
      },
      "slack",
    );
    expect(notice.text).toBe(
      "Sent 1 on Slack. 4 members notified in the portal. " +
        "1 not delivered (Slack delivery is switched off). 1 failed before sending. " +
        "Skipped 1: member has no slack_user_id.",
    );
    expect(notice.kind).toBe("error");
  });

  it("reports a clean send as a success", () => {
    expect(
      describeMemberNudgeResult(
        {
          created: [{ id: "a", status: "executed" }],
          skipped: [],
          portal_notified: ["mei"],
          deliveries: [{ member_id: "mei", action_id: "a", outcome: "executed" }],
        },
        "email",
      ),
    ).toEqual({ kind: "success", text: "Sent 1 on email. 1 member notified in the portal." });
  });

  it("keeps the old wording for a service that predates the split", () => {
    expect(
      describeMemberNudgeResult(
        {
          created: [{ id: "a", status: "executed" }],
          skipped: [{ member_id: "x", reason: "member not found" }],
        },
        "slack",
      ),
    ).toEqual({ kind: "error", text: "Sent 1 nudge. Skipped 1: member not found." });
  });
});
