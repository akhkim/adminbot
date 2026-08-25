// The checklist re-opens when somebody's standing changes, and the follow-up runs on that cycle's
// own clock rather than on the age of the account.
import { describe, expect, it } from "vitest";
import { AdminBotService, buildOnboardingChaseMessage } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const REAFFIRMED = ["compute_canada", "communication_norms"];
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function serviceWithMei() {
  const sent: string[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        sent.push(proposal.type);
        return { handled: true };
      },
    },
  });
  unwrap(
    service.upsertLabMember({
      id: "mei",
      name: "Mei Chen",
      privilege_level: "trial",
      status: "active",
      slack_user_id: "U-MEI",
    } as never),
  );
  return { service, sent };
}

/** Walks the whole checklist, the way a member finishing onboarding does. */
function acknowledgeEverything(service: AdminBotService, memberId: string) {
  for (const step of unwrap(service.listLabMembers()).members.find((m) => m.id === memberId)!
    .onboarding!.steps) {
    service.setOnboardingStep(memberId, step.id, true, "test");
  }
}

const meiOnboarding = (service: AdminBotService) =>
  unwrap(service.listLabMembers()).members.find((m) => m.id === "mei")!.onboarding!;

describe("a change of standing re-opens the checklist", () => {
  it("re-asks only the steps that are about standing", () => {
    const { service } = serviceWithMei();
    acknowledgeEverything(service, "mei");
    expect(meiOnboarding(service).steps.every((step) => step.status === "complete")).toBe(true);

    unwrap(service.upsertLabMember({ id: "mei", privilege_level: "member" } as never));

    const after = meiOnboarding(service);
    const reopened = after.steps.filter((step) => step.status !== "complete").map((s) => s.id);
    // Clearing the whole list on every promotion would teach people to click through reading
    // material without reading it.
    expect(reopened.toSorted()).toEqual(REAFFIRMED.toSorted());
    expect(after.reason).toBe("privilege_change");
    expect(after.opened_at).toBeTruthy();
  });

  it("re-opens on a status change too, and restarts the clock", () => {
    const { service } = serviceWithMei();
    acknowledgeEverything(service, "mei");
    const before = meiOnboarding(service).opened_at;
    unwrap(service.upsertLabMember({ id: "mei", status: "part_time" } as never));
    const after = meiOnboarding(service);
    expect(after.reason).toBe("status_change");
    expect(after.opened_at).not.toBe(before);
    // A new cycle gets its own ten days rather than inheriting a clock that already expired.
    expect(after.last_nudged_at).toBeUndefined();
  });

  it("leaves an ordinary profile save alone", () => {
    // A patch carries only what it is changing, so comparing the patch rather than the merged
    // record would read every save that omits `status` as a status change.
    const { service } = serviceWithMei();
    acknowledgeEverything(service, "mei");
    unwrap(service.upsertLabMember({ id: "mei", timezone: "Europe/Zurich" } as never));
    expect(meiOnboarding(service).steps.every((step) => step.status === "complete")).toBe(true);
  });
});

describe("chasing an open checklist", () => {
  function ageCycle(service: AdminBotService, days: number, lastNudgedDays?: number) {
    const member = unwrap(service.listLabMembers()).members.find((m) => m.id === "mei")!;
    (service as never as { store: { saveLabMember: (m: unknown) => void } }).store.saveLabMember({
      ...member,
      onboarding: {
        ...member.onboarding,
        opened_at: ago(days),
        ...(lastNudgedDays === undefined ? {} : { last_nudged_at: ago(lastNudgedDays) }),
      },
    });
  }

  it("says nothing for the first ten days", async () => {
    const { service, sent } = serviceWithMei();
    ageCycle(service, 9);
    expect(unwrap(await service.chaseOpenOnboarding("cron")).nudged).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("chases once the cycle is ten days old", async () => {
    const { service, sent } = serviceWithMei();
    ageCycle(service, 11);
    const result = unwrap(await service.chaseOpenOnboarding("cron"));
    expect(result.nudged).toEqual([expect.objectContaining({ member_id: "mei", days_open: 11 })]);
    expect(sent).toEqual(["member_nudge.send"]);
    expect(meiOnboarding(service).last_nudged_at).toBeTruthy();
  });

  it("then waits two months, not a day", async () => {
    const { service } = serviceWithMei();
    ageCycle(service, 40, 5);
    expect(unwrap(await service.chaseOpenOnboarding("cron")).nudged).toEqual([]);
    ageCycle(service, 200, 61);
    expect(unwrap(await service.chaseOpenOnboarding("cron")).nudged).toHaveLength(1);
  });

  it("does not chase a finished checklist, or somebody who has left", async () => {
    const { service } = serviceWithMei();
    acknowledgeEverything(service, "mei");
    ageCycle(service, 400);
    expect(unwrap(await service.chaseOpenOnboarding("cron")).nudged).toEqual([]);

    const { service: gone } = serviceWithMei();
    gone.upsertLabMember({ id: "mei", status: "alumni" } as never);
    expect(unwrap(await gone.chaseOpenOnboarding("cron")).nudged).toEqual([]);
  });

  it("files a notification even when the member has no Slack account", async () => {
    const { service } = serviceWithMei();
    unwrap(service.upsertLabMember({ id: "ben", name: "Ben Nevis", status: "active" } as never));
    const member = unwrap(service.listLabMembers()).members.find((m) => m.id === "ben")!;
    (service as never as { store: { saveLabMember: (m: unknown) => void } }).store.saveLabMember({
      ...member,
      onboarding: { ...member.onboarding, opened_at: ago(30) },
    });
    unwrap(await service.chaseOpenOnboarding("cron"));
    expect(unwrap(service.listMemberNotifications("ben")).notifications).toHaveLength(1);
  });

  it("does not escalate: onboarding reading is not a three-way DM", async () => {
    const { service } = serviceWithMei();
    ageCycle(service, 30);
    unwrap(await service.chaseOpenOnboarding("cron"));
    const filed = unwrap(service.listMemberNotifications("mei")).notifications;
    expect(filed[0]?.important).toBeUndefined();
  });
});

describe("buildOnboardingChaseMessage", () => {
  it("names the steps, and says why the list re-opened", () => {
    const promoted = buildOnboardingChaseMessage({
      openLabels: ["Apply for a Compute Canada (Alliance) account"],
      days: 12,
      reason: "privilege_change",
    });
    // A member who finished onboarding two years ago would otherwise read this as a bug.
    expect(promoted).toContain("standing in the lab changed");
    expect(promoted).toContain("• Apply for a Compute Canada");

    const fresh = buildOnboardingChaseMessage({
      openLabels: ["Set up your Drive folder"],
      days: 10,
      reason: "registration",
    });
    expect(fresh).toContain("open for 10 days");
  });
});
