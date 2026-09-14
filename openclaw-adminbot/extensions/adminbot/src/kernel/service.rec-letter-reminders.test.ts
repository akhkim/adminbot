// The sweep end to end: what reaches the professor's inbox, and that one letter reaches it once.
import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequestInput } from "../contracts/actions.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const NOW = "2026-11-28T09:00:00Z";

const LETTERS: AdminBotLogisticsRequestInput = {
  kind: "recommendation_letters",
  schools: [{ school: "MIT", letter_deadline: "2026-12-01" }],
  facts: [{ project: "AdminBot", contribution: "wrote the approval gate" }],
};

function labWithMail(options: { headProfessorEmail?: string | undefined } = {}) {
  const sent: { to: string; subject: string; body: string }[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        if (proposal.type !== "logistics.rec_letter_reminder") {
          return { handled: false };
        }
        sent.push(proposal.proposed_payload as never);
        return { handled: true };
      },
    },
  });
  unwrap(service.upsertLabMember({ id: "ada", name: "Ada Lovelace", privilege_level: "member" }));
  unwrap(service.upsertLabMember({ id: "grace", name: "Grace Hopper", privilege_level: "member" }));
  const email =
    "headProfessorEmail" in options ? options.headProfessorEmail : "zjin@cs.toronto.edu";
  unwrap(
    service.upsertLabMember({
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
      ...(email ? { email } : {}),
    }),
  );
  unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
  return { service, sent };
}

describe("sweepRecLetterReminders", () => {
  it("mails the head professor three days before the deadline", async () => {
    const { service, sent } = labWithMail();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));

    const result = unwrap(await service.sweepRecLetterReminders("cron", { nowIso: NOW }));

    expect(result.recipient).toBe("zjin@cs.toronto.edu");
    expect(result.reminded).toEqual([
      {
        request_id: request.id,
        member_id: "ada",
        deadline_at: request.deadline_at,
        days_until: 3,
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("zjin@cs.toronto.edu");
    expect(sent[0]?.subject).toBe("Recommendation letter for Ada Lovelace is due in 3 days");
    expect(sent[0]?.body).toContain("Ada Lovelace");
    expect(sent[0]?.body).toContain("MIT");
  });

  it("says nothing while the deadline is further off than the window", async () => {
    const { service, sent } = labWithMail();
    unwrap(
      service.submitLogisticsRequest("ada", {
        ...LETTERS,
        schools: [{ school: "MIT", letter_deadline: "2026-12-20" }],
      }),
    );

    const result = unwrap(await service.sweepRecLetterReminders("cron", { nowIso: NOW }));

    expect(result.reminded).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("says it once, however often the pass runs", async () => {
    const { service, sent } = labWithMail();
    unwrap(service.submitLogisticsRequest("ada", LETTERS));

    unwrap(await service.sweepRecLetterReminders("cron", { nowIso: NOW }));
    const second = unwrap(
      await service.sweepRecLetterReminders("cron", { nowIso: "2026-11-29T09:00:00Z" }),
    );

    expect(second.reminded).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("says it again when the school moves the deadline", async () => {
    const { service, sent } = labWithMail();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    unwrap(await service.sweepRecLetterReminders("cron", { nowIso: NOW }));

    unwrap(
      service.updateLogisticsRequest(request.id, "ada", {
        ...LETTERS,
        schools: [{ school: "MIT", letter_deadline: "2026-11-30" }],
      } as never),
    );
    const again = unwrap(await service.sweepRecLetterReminders("cron", { nowIso: NOW }));

    expect(again.reminded).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("sends one mail for every letter due, not one mail each", async () => {
    const { service, sent } = labWithMail();
    unwrap(service.submitLogisticsRequest("ada", LETTERS));
    unwrap(service.submitLogisticsRequest("grace", LETTERS));

    const result = unwrap(await service.sweepRecLetterReminders("cron", { nowIso: NOW }));

    expect(result.reminded).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("2 recommendation letters due within 3 days");
    expect(sent[0]?.body).toContain("Grace Hopper");
  });

  it("refuses rather than guessing when the professor has no address on the roster", async () => {
    const { service, sent } = labWithMail({ headProfessorEmail: undefined });
    unwrap(service.submitLogisticsRequest("ada", LETTERS));

    const result = await service.sweepRecLetterReminders("cron", { nowIso: NOW });

    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("is quiet, not broken, on a deployment with no head professor and nothing due", async () => {
    const { service } = labWithMail();
    unwrap(service.updateSettings({ head_professor_member_id: "" } as never));

    const result = unwrap(await service.sweepRecLetterReminders("cron", { nowIso: NOW }));

    expect(result.reminded).toEqual([]);
  });
});
