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
  // The desk that tracks the chore. The professor still does the grading; they are simply not the
  // person AdminBot DMs about it.
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

  it("asks the lab manager to chase the grading five days after", async () => {
    const service = serviceWith();
    setThesis(service, onDay(-6));
    const result = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));

    expect(result.grading).toEqual([{ member_id: "mei", date: onDay(-6), days_since: 6 }]);
    const told = notificationsFor(service, "andrew");
    expect(told[0]?.title).toBe("A thesis is ready to grade");
    expect(told[0]?.body).toContain("Mei Chen");
    // Not the professor, even though the grading is theirs. AdminBot does not chase the PI.
    expect(notificationsFor(service, "zhijing")).toEqual([]);
    // And not the student: somebody who has just submitted does not need to watch their supervisor
    // being reminded to mark it.
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

  it("falls back to the Slack-linked admins when no lab manager is configured", async () => {
    const service = serviceWith({ headProfessor: false });
    setThesis(service, onDay(-6));
    const result = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    expect(result.grading).toHaveLength(1);
    // A thesis waiting to be marked is worth saying to somebody rather than nobody.
    expect(notificationsFor(service, "andrew")[0]?.title).toBe("A thesis is ready to grade");
  });

  it("reports rather than guesses when no admin can be reminded", async () => {
    const service = serviceWith({ headProfessor: false });
    // Every admin off Slack: the sweep has a chore and nowhere to put it, and says so.
    for (const id of ["zhijing", "andrew"]) {
      unwrap(service.upsertLabMember({ id, slack_user_id: "" } as never));
    }
    setThesis(service, onDay(-6));
    const result = unwrap(await service.sweepThesisMilestones("cron", { nowIso: NOW }));
    expect(result.grading).toHaveLength(1);
    expect(result.skipped).toContainEqual({
      member_id: "lab_manager",
      reason: "no admin with a linked Slack account to remind",
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
