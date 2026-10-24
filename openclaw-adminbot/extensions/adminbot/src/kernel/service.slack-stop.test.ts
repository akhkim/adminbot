// "stop" DMed to AdminBot at the service boundary, on synthetic members. The Slack executor is a
// mock that records what would have been sent.
import { describe, expect, it } from "vitest";
import { AdminBotService, type AdminBotServiceStore } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function lab() {
  const sent: string[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        sent.push(proposal.type);
        return { handled: true };
      },
    },
    now: () => new Date("2026-10-20T15:00:00.000Z"),
  });
  unwrap(
    service.upsertLabMember({
      id: "mei",
      name: "Mei Chen",
      privilege_level: "member",
      member_type: "full",
      receives_nudges: true,
      slack_user_id: "U-MEI",
    } as never),
  );
  const store = (service as unknown as { store: AdminBotServiceStore }).store;
  return { service, store, sent };
}

describe("applySlackStop", () => {
  it("records a stop once, audits it, and replies without claiming a second change", () => {
    const { service, store } = lab();
    const first = unwrap(service.applySlackStop({ slackUserId: " U-MEI ", command: "stop" }));
    expect(first).toMatchObject({ matched: true, changed: true });
    expect(first.reply).toContain("*start*");
    expect(store.getLabMember("mei")?.slack_stop_at).toBe("2026-10-20T15:00:00.000Z");

    const again = unwrap(service.applySlackStop({ slackUserId: "U-MEI", command: "stop" }));
    expect(again).toMatchObject({ matched: true, changed: false });
    expect(again.reply).toMatch(/already opted out/u);
    expect(
      service.listAuditEvents().filter((event) => event.type === "member.slack_stopped"),
    ).toHaveLength(1);
  });

  it("clears the stop on start and leaves the admin nudge list alone", () => {
    const { service, store } = lab();
    unwrap(service.applySlackStop({ slackUserId: "U-MEI", command: "stop" }));
    const result = unwrap(service.applySlackStop({ slackUserId: "U-MEI", command: "start" }));
    expect(result).toMatchObject({ matched: true, changed: true });
    expect(store.getLabMember("mei")?.slack_stop_at).toBeUndefined();
    expect(store.getLabMember("mei")?.receives_nudges).toBe(true);
    expect(service.listAuditEvents().map((event) => event.type)).toContain("member.slack_started");
  });

  it("matches nobody for an unknown Slack user, and rejects a bad command", () => {
    const { service } = lab();
    expect(unwrap(service.applySlackStop({ slackUserId: "U-NOBODY", command: "stop" }))).toEqual({
      matched: false,
      changed: false,
    });
    expect(service.applySlackStop({ slackUserId: "", command: "stop" }).ok).toBe(false);
    expect(service.applySlackStop({ slackUserId: "U-MEI", command: "pause" as never }).ok).toBe(
      false,
    );
  });
});

describe("what stop silences", () => {
  it("skips optional nudges but still delivers lab-work reminders", async () => {
    const { service } = lab();
    unwrap(service.applySlackStop({ slackUserId: "U-MEI", command: "stop" }));
    const optional = unwrap(
      await service.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: ["mei"],
          message: "Add a profile photo?",
          optional: true,
        },
        "test",
      ),
    ) as { skipped: Array<{ member_id: string; reason: string }> };
    expect(optional.skipped).toEqual([{ member_id: "mei", reason: "member replied stop" }]);

    const essential = unwrap(
      await service.sendMemberNudge(
        { channel: "slack", recipient_member_ids: ["mei"], message: "Your camera-ready is due." },
        "test",
      ),
    ) as { skipped: unknown[] };
    expect(essential.skipped).toEqual([]);
  });

  it("is lifted by turning an intro back on in the portal", () => {
    const { service, store } = lab();
    unwrap(service.applySlackStop({ slackUserId: "U-MEI", command: "stop" }));
    unwrap(service.meetups().setPreferences("mei", { snoozed_until: "2026-10-30" }));
    expect(store.getLabMember("mei")?.slack_stop_at).toBeDefined();
    unwrap(service.meetups().setPreferences("mei", { city: true }));
    expect(store.getLabMember("mei")?.slack_stop_at).toBeUndefined();
  });
});
