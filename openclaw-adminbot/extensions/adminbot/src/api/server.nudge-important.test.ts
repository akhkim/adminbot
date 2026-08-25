// The one nudge route whose text and recipients come from a browser must not be able to raise the
// flag that puts the head professor in a group DM five days later.
import { describe, expect, it, vi } from "vitest";
import { AdminBotService } from "../kernel/service.js";

describe("POST /nudges/send", () => {
  it("drops an important flag an admin supplied, and sends the nudge anyway", async () => {
    const service = new AdminBotService(undefined, {
      executor: { execute: async () => ({ handled: true }) },
    });
    service.upsertLabMember({
      id: "mei",
      name: "Mei Chen",
      privilege_level: "member",
      slack_user_id: "U-MEI",
    } as never);

    // Exactly what the route does with the parsed body.
    const body = {
      channel: "slack" as const,
      recipient_member_ids: ["mei"],
      message: "Please do the thing.",
      title: "Do the thing",
      important: true,
    };
    const { important: _ignored, ...request } = body;
    const sent = await service.sendMemberNudge(request, "admin-1");
    expect(sent.ok).toBe(true);

    const filed = service.listMemberNotifications("mei");
    if (!filed.ok) {
      throw new Error(filed.error.message);
    }
    // Told, listed and warned about -- everything except escalated. "AdminBot escalated this" has
    // to mean a sweep decided, not that an admin typed something and waited.
    expect(filed.payload.notifications).toHaveLength(1);
    expect(filed.payload.notifications[0]?.title).toBe("Do the thing");
    expect(filed.payload.notifications[0]?.important).toBeUndefined();
  });

  it("keeps the flag out of the escalation sweep's reach", async () => {
    const escalate = vi.fn();
    const service = new AdminBotService(undefined, {
      executor: {
        execute: async (proposal) => {
          if (proposal.type === "member_nudge.escalate") {
            escalate();
          }
          return { handled: true };
        },
      },
    });
    for (const member of [
      { id: "zhijing", name: "Zhijing Jin", privilege_level: "admin", slack_user_id: "U-ZJ" },
      { id: "mei", name: "Mei Chen", privilege_level: "member", slack_user_id: "U-MEI" },
    ]) {
      service.upsertLabMember(member as never);
    }
    service.updateSettings({ head_professor_member_id: "zhijing" } as never);

    const body = {
      channel: "slack" as const,
      recipient_member_ids: ["mei"],
      message: "hi",
      important: true,
    };
    const { important: _ignored, ...request } = body;
    await service.sendMemberNudge(request, "admin-1");

    const listed = service.listMemberNotifications("mei");
    if (!listed.ok) {
      throw new Error(listed.error.message);
    }
    for (const notification of listed.payload.notifications) {
      (
        service as never as { store: { saveMemberNotification: (n: unknown) => void } }
      ).store.saveMemberNotification({
        ...notification,
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    const result = await service.escalateStaleNudges("cron");
    expect(result.ok).toBe(true);
    expect(escalate).not.toHaveBeenCalled();
  });
});
