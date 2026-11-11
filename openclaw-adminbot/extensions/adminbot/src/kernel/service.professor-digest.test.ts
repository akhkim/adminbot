// The digest end to end: what reaches the professor's inbox, at most once a day, until resolved.
import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequestInput } from "../contracts/actions.js";
import {
  professorDigestDefaults,
  type ProfessorDigestConfig,
} from "../workflows/nudges/professor-digest.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

// 09:00 in Toronto (EST, UTC-5).
const MORNING = "2027-03-01T14:00:00Z";
const LATER_SAME_DAY = "2027-03-01T20:00:00Z";
const NEXT_MORNING = "2027-03-02T14:00:00Z";
const ENABLED: ProfessorDigestConfig = { ...professorDigestDefaults, enabled: true };

/** Due 2027-03-02 AoE: inside 48 hours on MORNING. */
const LETTER_DUE_TOMORROW: AdminBotLogisticsRequestInput = {
  kind: "recommendation_letters",
  schools: [{ school: "MIT", letter_deadline: "2027-03-02" }],
  facts: [{ project: "AdminBot", contribution: "wrote the approval gate" }],
};

function lab(options: { executorError?: Error; headProfessorEmail?: string | null } = {}) {
  const sent: { to: string; subject: string; body: string }[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        if (proposal.type !== "professor.escalation_digest") {
          return { handled: false };
        }
        if (options.executorError) {
          throw options.executorError;
        }
        sent.push(proposal.proposed_payload as never);
        return { handled: true };
      },
    },
  });
  unwrap(service.upsertLabMember({ id: "ada", name: "Ada Lovelace", privilege_level: "member" }));
  const email =
    options.headProfessorEmail === null
      ? undefined
      : (options.headProfessorEmail ?? "zjin@cs.toronto.edu");
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

describe("sweepProfessorDigest", () => {
  it("mails the head professor one grouped digest with portal links", async () => {
    const { service, sent } = lab();
    unwrap(service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));

    const result = unwrap(await service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING }));

    expect(result).toMatchObject({
      outcome: "sent",
      recipient: "zjin@cs.toronto.edu",
      local_date: "2027-03-01",
      counts: { overdue: 0, due_48h: 1, due_7d: 0, waiting: 0 },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("zjin@cs.toronto.edu");
    expect(sent[0]?.subject).toBe("AdminBot: Due within 48 hours: 1 item");
    expect(sent[0]?.body).toContain("DUE WITHIN 48 HOURS (1)");
    expect(sent[0]?.body).toContain("Recommendation letter for Ada Lovelace — MIT");
    expect(sent[0]?.body).toMatch(/https:\/\/\S+\/rec-letters/u);
  });

  it("sends at most once per local day, however often the cron runs", async () => {
    const { service, sent } = lab();
    unwrap(service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));

    unwrap(await service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING }));
    const again = unwrap(
      await service.sweepProfessorDigest("cron", ENABLED, { nowIso: LATER_SAME_DAY }),
    );

    expect(again.outcome).toBe("already_sent_today");
    expect(sent).toHaveLength(1);
  });

  it("repeats the next day while unresolved, escalating once it is past due", async () => {
    const { service, sent } = lab();
    unwrap(service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));
    unwrap(await service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING }));

    // AoE end of 2027-03-02 is 2027-03-03T11:59Z; two days on it is overdue and already flagged.
    const overdue = unwrap(
      await service.sweepProfessorDigest("cron", ENABLED, { nowIso: "2027-03-04T14:00:00Z" }),
    );

    expect(overdue.counts?.overdue).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toBe("AdminBot: STILL OVERDUE: 1 item past deadline");
    expect(sent[1]?.body).toContain("[reminder #2]");
  });

  it("stops once the item is resolved", async () => {
    const { service, sent } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));
    unwrap(await service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING }));

    unwrap(service.setLogisticsRequestStatus(request.id, "completed", "zhijing"));
    const next = unwrap(
      await service.sweepProfessorDigest("cron", ENABLED, { nowIso: NEXT_MORNING }),
    );

    expect(next.outcome).toBe("nothing_due");
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when nothing is waiting, and does not need a recipient to say so", async () => {
    const { service, sent } = lab({ headProfessorEmail: null });

    const result = unwrap(await service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING }));

    expect(result.outcome).toBe("nothing_due");
    expect(sent).toHaveLength(0);
  });

  it("is off unless enabled, and waits for the send hour", async () => {
    const { service, sent } = lab();
    unwrap(service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));

    const off = unwrap(
      await service.sweepProfessorDigest("cron", professorDigestDefaults, { nowIso: MORNING }),
    );
    // 06:00 Toronto.
    const early = unwrap(
      await service.sweepProfessorDigest("cron", ENABLED, { nowIso: "2027-03-01T11:00:00Z" }),
    );

    expect(off.outcome).toBe("disabled");
    expect(early.outcome).toBe("before_send_hour");
    expect(sent).toHaveLength(0);
  });

  it("previews without sending or stamping, even while off", async () => {
    const { service, sent } = lab();
    unwrap(service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));

    const preview = unwrap(
      await service.sweepProfessorDigest("cron", professorDigestDefaults, {
        nowIso: MORNING,
        dryRun: true,
      }),
    );
    const real = unwrap(await service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING }));

    expect(preview.outcome).toBe("preview");
    expect(preview.subject).toBe("AdminBot: Due within 48 hours: 1 item");
    expect(real.outcome).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("refuses rather than guessing when the professor has no address on the roster", async () => {
    const { service, sent } = lab({ headProfessorEmail: null });
    unwrap(service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));

    const result = await service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(sent).toHaveLength(0);
  });

  it("retries next hour when gog failed before sending, but not after an ambiguous failure", async () => {
    const before = lab({
      executorError: new Error("gog: dial tcp: lookup gmail.googleapis.com: no such host"),
    });
    unwrap(before.service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));
    expect(
      await before.service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING }),
    ).toMatchObject({ ok: false, status: 502 });
    const retried = await before.service.sweepProfessorDigest("cron", ENABLED, {
      nowIso: LATER_SAME_DAY,
    });
    expect(retried).toMatchObject({ ok: false, status: 502 });

    const ambiguous = lab({ executorError: new Error("gog: connection reset mid-response") });
    unwrap(ambiguous.service.submitLogisticsRequest("ada", LETTER_DUE_TOMORROW));
    expect(
      await ambiguous.service.sweepProfessorDigest("cron", ENABLED, { nowIso: MORNING }),
    ).toMatchObject({ ok: false, status: 502 });
    const held = unwrap(
      await ambiguous.service.sweepProfessorDigest("cron", ENABLED, { nowIso: LATER_SAME_DAY }),
    );
    expect(held.outcome).toBe("already_sent_today");
  });
});
