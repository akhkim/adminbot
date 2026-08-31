// The sweep end to end: who hears what, and that nobody hears it twice.
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

const NOW = "2026-06-01T09:00:00Z";
const onDay = (offset: number) =>
  new Date(Date.UTC(2026, 5, 1 + offset)).toISOString().slice(0, 10);

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
  if (options.headProfessor !== false) {
    unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
  }
  return service;
}

function setThesis(service: AdminBotService, date: string) {
  unwrap(
    service.updateOwnProfile("mei", {
      milestones: [{ date, label: "Thesis draft" }],
    } as never),
  );
}

const notificationsFor = (service: AdminBotService, id: string) =>
  unwrap(service.listMemberNotifications(id)).notifications;

describe("sweepThesisMilestones", () => {
  it("points the member at the guidebook as the date approaches", async () => {
    const service = serviceWith();
    setThesis(service, onDay(10));
    const result = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));

    expect(result.guidance).toEqual([{ member_id: "mei", date: onDay(10), days_until: 10 }]);
    expect(result.grading).toEqual([]);
    const told = notificationsFor(service, "mei");
    expect(told[0]?.title).toBe("Your thesis deadline is coming up");
    expect(told[0]?.body).toContain("Submitting your thesis");
    // The professor is not told about a thesis that has not happened yet.
    expect(notificationsFor(service, "zhijing")).toEqual([]);
  });

  it("asks the head professor to grade it five days after", async () => {
    const service = serviceWith();
    setThesis(service, onDay(-6));
    const result = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));

    expect(result.grading).toEqual([{ member_id: "mei", date: onDay(-6), days_since: 6 }]);
    const told = notificationsFor(service, "zhijing");
    expect(told[0]?.title).toBe("A thesis is ready to grade");
    expect(told[0]?.body).toContain("Mei Chen");
    // Addressed to her about them: a student who has just submitted does not need to watch their
    // supervisor being reminded to mark it.
    expect(notificationsFor(service, "mei")).toEqual([]);
  });

  it("says each thing once", async () => {
    const service = serviceWith();
    setThesis(service, onDay(10));
    unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    const again = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    expect(again.guidance).toEqual([]);
    expect(notificationsFor(service, "mei")).toHaveLength(1);
  });

  it("says it again when the member moves the date", async () => {
    const service = serviceWith();
    setThesis(service, onDay(10));
    unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    setThesis(service, onDay(4));
    const moved = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    // A new date is a new deadline, and the guidebook reading is worth repeating against it.
    expect(moved.guidance).toEqual([{ member_id: "mei", date: onDay(4), days_until: 4 }]);
  });

  it("still says both, in order, as one thesis moves through its window", async () => {
    const service = serviceWith();
    setThesis(service, onDay(-6));
    // The guidance window closed before this sweep ever ran, so only grading is due.
    const late = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    expect(late.guidance).toEqual([]);
    expect(late.grading).toHaveLength(1);
  });

  it("reports rather than guesses when no head professor is configured", async () => {
    const service = serviceWith({ headProfessor: false });
    setThesis(service, onDay(-6));
    const result = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    expect(result.grading).toHaveLength(1);
    expect(result.skipped).toContainEqual({
      member_id: "head_professor",
      reason: "no head professor is configured to remind",
    });
  });

  it("does nothing for a timeline with no thesis on it", async () => {
    const service = serviceWith();
    unwrap(
      service.updateOwnProfile("mei", {
        milestones: [{ date: onDay(2), label: "Conference travel" }],
      } as never),
    );
    const result = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    expect(result.guidance).toEqual([]);
    expect(result.grading).toEqual([]);
  });
});
