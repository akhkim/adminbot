// The sweep end to end: who is asked what, that nobody is asked twice, and that it never sets a
// status itself.
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

const NOW = "2026-06-15T09:00:00Z";

function serviceWith(options: { headProfessor?: boolean } = {}) {
  const service = new AdminBotService(undefined, {
    executor: { execute: async () => ({ handled: true }) },
  });
  unwrap(
    service.upsertLabMember({
      receives_nudges: true,
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
      slack_user_id: "U-ZJ",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      receives_nudges: true,
      id: "mei",
      name: "Mei Chen",
      privilege_level: "member",
      status: "active",
      slack_user_id: "U-MEI",
    } as never),
  );
  // The desk the lab's chores land on. Separate from the professor on purpose: the sweep's notices
  // are administration, and AdminBot does not chase the PI.
  unwrap(
    service.upsertLabMember({
      receives_nudges: true,
      id: "andrew",
      name: "Andrew Kim",
      privilege_level: "admin",
      status: "active",
      slack_user_id: "U-AK",
    } as never),
  );
  if (options.headProfessor !== false) {
    unwrap(
      service.updateSettings({
        head_professor_member_id: "zhijing",
        lab_manager_member_id: "andrew",
      } as never),
    );
  }
  return service;
}

const setMonth = (service: AdminBotService, month: string) =>
  unwrap(service.updateOwnProfile("mei", { graduated_month: month } as never));

const told = (service: AdminBotService, id: string) =>
  unwrap(service.listMemberNotifications(id)).notifications;

const memberById = (service: AdminBotService, id: string) =>
  unwrap(service.listLabMembers()).members.find((entry) => entry.id === id);

describe("sweepGraduations", () => {
  it("asks the member about their own date, and nobody else", async () => {
    const service = serviceWith();
    setMonth(service, "2026-03");
    // January: the March date is inside the confirm window and June's ceremony is not yet in view,
    // so the member is the only person this run has anything to say to.
    const result = unwrap(
      await service.sweepGraduations("cron", { nowIso: "2026-01-15T09:00:00Z" }),
    );

    expect(result.confirmed).toEqual([{ member_id: "mei", month: "2026-03" }]);
    expect(told(service, "mei")[0]?.title).toBe("Is your finishing month still right?");
    expect(told(service, "zhijing")).toEqual([]);
  });

  it("asks the lab manager once the month has passed, and does not set the status itself", async () => {
    const service = serviceWith();
    setMonth(service, "2026-04");
    const result = unwrap(await service.sweepGraduations("cron", { nowIso: NOW }));

    expect(result.transitions).toEqual([{ member_id: "mei", month: "2026-04" }]);
    expect(told(service, "andrew")[0]?.body).toContain("Mei Chen");
    // Not the professor. A finishing month that has passed is paperwork, not an escalation.
    expect(told(service, "zhijing")).toEqual([]);
    // Flipping a status has access consequences; a sweep asks, it does not perform.
    expect(memberById(service, "mei")?.status).toBe("active");
    expect(told(service, "mei")).toEqual([]);
  });

  it("stops asking as soon as an admin has made the transition", async () => {
    const service = serviceWith();
    setMonth(service, "2026-04");
    unwrap(await service.sweepGraduations("cron", { nowIso: NOW }));
    unwrap(service.upsertLabMember({ receives_nudges: true, id: "mei", status: "alumni" } as never));
    const after = unwrap(await service.sweepGraduations("cron", { nowIso: NOW }));
    expect(after.transitions).toEqual([]);
  });

  it("asks once per month value, and again when the member moves it", async () => {
    const service = serviceWith();
    setMonth(service, "2026-07");
    unwrap(await service.sweepGraduations("cron", { nowIso: NOW }));
    expect(unwrap(await service.sweepGraduations("cron", { nowIso: NOW })).confirmed).toEqual([]);

    setMonth(service, "2026-08");
    const moved = unwrap(await service.sweepGraduations("cron", { nowIso: NOW }));
    expect(moved.confirmed).toEqual([{ member_id: "mei", month: "2026-08" }]);
  });

  it("raises the ceremony once a year", async () => {
    const service = serviceWith();
    setMonth(service, "2026-06");
    const result = unwrap(
      await service.sweepGraduations("cron", { nowIso: "2026-04-01T09:00:00Z" }),
    );
    expect(result.ceremony).toEqual({ year: 2026, graduates: 1 });
    const ceremonyNote = told(service, "andrew").find((entry) =>
      entry.title.includes("graduation ceremony"),
    );
    expect(ceremonyNote?.body).toContain("Mei Chen");

    // Not raised again, and not reported again either: the weekly cron summary would otherwise
    // print the ceremony for three months and read as the reminder firing every time.
    const again = unwrap(
      await service.sweepGraduations("cron", { nowIso: "2026-04-08T09:00:00Z" }),
    );
    expect(again.ceremony).toBeUndefined();
    expect(
      told(service, "andrew").filter((entry) => entry.title.includes("graduation ceremony")),
    ).toHaveLength(1);
  });

  it("falls back to the admins when no lab manager is configured", async () => {
    const service = serviceWith({ headProfessor: false });
    setMonth(service, "2026-04");
    unwrap(await service.sweepGraduations("cron", { nowIso: NOW }));
    // Saying nothing about somebody who has left is the worse failure.
    expect(told(service, "zhijing")[0]?.body).toContain("Mei Chen");
    expect(told(service, "andrew")[0]?.body).toContain("Mei Chen");
  });

  it("does nothing for a roster with no finishing months on it", async () => {
    const service = serviceWith();
    const result = unwrap(await service.sweepGraduations("cron", { nowIso: NOW }));
    expect(result.confirmed).toEqual([]);
    expect(result.transitions).toEqual([]);
    expect(result.ceremony).toBeUndefined();
  });
});
