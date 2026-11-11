// The after-deadline sweep end to end, and the student's answer to it.
import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequestInput } from "../contracts/actions.js";
import { AdminBotService } from "./service.js";
import { resolveRecLetterOverdueConfig } from "./service.rec-letter-overdue.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

// Past the 2026-12-01 23:59 AoE deadline below, inside the 60-day window.
const NOW = "2026-12-10T13:00:00Z";
const ON = { enabled: true };

const LETTERS: AdminBotLogisticsRequestInput = {
  kind: "recommendation_letters",
  schools: [{ school: "MIT", letter_deadline: "2026-12-01" }],
  facts: [{ project: "AdminBot", contribution: "wrote the approval gate" }],
};

function lab(options: { failSend?: boolean } = {}) {
  const sent: { to: string; subject: string; body: string }[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        if (proposal.type !== "logistics.rec_letter_overdue_check") {
          return { handled: false };
        }
        if (options.failSend) {
          throw new Error("gog: could not reach Google");
        }
        sent.push(proposal.proposed_payload as never);
        return { handled: true };
      },
    },
  });
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
      email: "ada@cs.toronto.edu",
      correspondence_email: "ada@example.org",
    } as never),
  );
  unwrap(service.upsertLabMember({ id: "grace", name: "Grace Hopper", privilege_level: "member" }));
  unwrap(
    service.upsertLabMember({
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
      email: "zjin@cs.toronto.edu",
    }),
  );
  return { service, sent };
}

function audits(service: AdminBotService, type: string) {
  return service.listAuditEvents().filter((event) => event.type === type);
}

describe("resolveRecLetterOverdueConfig", () => {
  it("is off unless the flag is exactly 1", () => {
    expect(resolveRecLetterOverdueConfig({}).enabled).toBe(false);
    expect(
      resolveRecLetterOverdueConfig({ ADMINBOT_REC_LETTER_OVERDUE_CONFIRM_ENABLED: "true" })
        .enabled,
    ).toBe(false);
    expect(
      resolveRecLetterOverdueConfig({ ADMINBOT_REC_LETTER_OVERDUE_CONFIRM_ENABLED: "1" }).enabled,
    ).toBe(true);
  });
});

describe("sweepRecLetterOverdueConfirmations", () => {
  it("sends nothing while it is off", async () => {
    const { service, sent } = lab();
    unwrap(service.submitLogisticsRequest("ada", LETTERS));

    const result = unwrap(
      await service.sweepRecLetterOverdueConfirmations("cron", { enabled: false }, { nowIso: NOW }),
    );

    expect(result.outcome).toBe("disabled");
    expect(sent).toEqual([]);
  });

  it("previews the mail on a dry run, even while off, without sending or stamping", async () => {
    const { service, sent } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));

    const preview = unwrap(
      await service.sweepRecLetterOverdueConfirmations(
        "cron",
        { enabled: false },
        { nowIso: NOW, dryRun: true },
      ),
    );

    expect(preview.outcome).toBe("preview");
    expect(preview.previews).toHaveLength(1);
    expect(preview.previews[0]).toMatchObject({
      member_id: "ada",
      to: "ada@example.org",
      subject: "Did your recommendation letter go in?",
      requests: [{ request_id: request.id }],
    });
    expect(preview.previews[0]?.body).toContain("/rec-letters?view=requests");
    expect(sent).toEqual([]);
    expect(audits(service, "rec_letter_overdue.swept")).toEqual([]);

    // Nothing was stamped, so the real run still asks.
    const real = unwrap(
      await service.sweepRecLetterOverdueConfirmations("cron", ON, { nowIso: NOW }),
    );
    expect(real.sent).toHaveLength(1);
  });

  it("mails the student once, to their correspondence address, and leaves a notification", async () => {
    const { service, sent } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));

    const result = unwrap(
      await service.sweepRecLetterOverdueConfirmations("cron", ON, { nowIso: NOW }),
    );

    expect(result.outcome).toBe("swept");
    expect(result.sent).toEqual([
      expect.objectContaining({
        member_id: "ada",
        to: "ada@example.org",
        requests: [expect.objectContaining({ request_id: request.id })],
      }),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ada@example.org");
    expect(sent[0]?.body).toContain("still shows it as not submitted");
    expect(sent[0]?.body).toContain("MIT");

    const notes = unwrap(service.listMemberNotifications("ada")).notifications;
    expect(notes.filter((note) => note.kind === "rec_letter")).toHaveLength(1);
    expect(audits(service, "rec_letter_overdue.swept")).toHaveLength(1);

    const again = unwrap(
      await service.sweepRecLetterOverdueConfirmations("cron", ON, {
        nowIso: "2026-12-11T13:00:00Z",
      }),
    );
    expect(again.outcome).toBe("nothing_due");
    expect(sent).toHaveLength(1);
  });

  it("never mails the professor, and skips a student with no address rather than guessing", async () => {
    const { service, sent } = lab();
    unwrap(service.submitLogisticsRequest("grace", LETTERS));

    const result = unwrap(
      await service.sweepRecLetterOverdueConfirmations("cron", ON, { nowIso: NOW }),
    );

    expect(result.sent).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ member_id: "grace", reason: "no_email" }),
    ]);
    expect(sent).toEqual([]);

    // Unstamped: once the roster has an address, the next run asks.
    unwrap(
      service.upsertLabMember({
        id: "grace",
        name: "Grace Hopper",
        privilege_level: "member",
        email: "grace@cs.toronto.edu",
      }),
    );
    const next = unwrap(
      await service.sweepRecLetterOverdueConfirmations("cron", ON, { nowIso: NOW }),
    );
    expect(next.sent.map((entry) => entry.to)).toEqual(["grace@cs.toronto.edu"]);
  });

  it("does not stamp a failed send, so the next run tries again", async () => {
    const failing = lab({ failSend: true });
    unwrap(failing.service.submitLogisticsRequest("ada", LETTERS));

    const result = unwrap(
      await failing.service.sweepRecLetterOverdueConfirmations("cron", ON, { nowIso: NOW }),
    );

    expect(result.sent).toEqual([]);
    expect(result.failed).toEqual([expect.objectContaining({ member_id: "ada" })]);
    const retry = unwrap(
      await failing.service.sweepRecLetterOverdueConfirmations("cron", ON, { nowIso: NOW }),
    );
    expect(retry.failed).toHaveLength(1);
  });

  it("leaves settled requests alone", async () => {
    const { service, sent } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    unwrap(service.setLogisticsRequestStatus(request.id, "completed", "zhijing"));

    const result = unwrap(
      await service.sweepRecLetterOverdueConfirmations("cron", ON, { nowIso: NOW }),
    );

    expect(result.outcome).toBe("nothing_due");
    expect(sent).toEqual([]);
  });
});

describe("the student's answer", () => {
  it("records that the student confirmed it after the reminder, and retracts the card", async () => {
    const { service } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    unwrap(await service.sweepRecLetterOverdueConfirmations("cron", ON, { nowIso: NOW }));

    const confirmed = unwrap(service.confirmLetterSubmitted(request.id, "ada"));

    expect(confirmed).toMatchObject({
      status: "completed",
      confirmed_by: "ada",
      confirmed_by_name: "Ada Lovelace",
      confirmed_via: "member_after_reminder",
    });
    expect(confirmed.confirmed_at).toBeTruthy();
    expect(audits(service, "logistics_request.letter_confirmed")[0]?.details).toMatchObject({
      request_id: request.id,
      via: "member_after_reminder",
    });
    const notes = unwrap(service.listMemberNotifications("ada")).notifications;
    expect(notes.find((note) => note.kind === "rec_letter")?.resolved_at).toBeTruthy();
  });

  it("records an unprompted confirmation as the student's own", () => {
    const { service } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));

    expect(unwrap(service.confirmLetterSubmitted(request.id, "ada")).confirmed_via).toBe("member");
  });

  it("undoes the student's own confirmation back to submitted, audited", () => {
    const { service } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));
    unwrap(service.confirmLetterSubmitted(request.id, "ada"));

    const reopened = unwrap(service.undoLetterConfirmation(request.id, "ada"));

    expect(reopened.status).toBe("submitted");
    expect(reopened.confirmed_by).toBeUndefined();
    expect(reopened.confirmed_via).toBeUndefined();
    expect(audits(service, "logistics_request.letter_confirmation_undone")).toHaveLength(1);
  });

  it("refuses someone else's request, other kinds, and settled requests", () => {
    const { service } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));

    expect(service.confirmLetterSubmitted(request.id, "grace")).toMatchObject({
      ok: false,
      status: 404,
    });
    unwrap(service.setLogisticsRequestStatus(request.id, "declined", "zhijing"));
    expect(service.confirmLetterSubmitted(request.id, "ada")).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("will not let the student reopen a letter the professor marked", () => {
    const { service } = lab();
    const request = unwrap(service.submitLogisticsRequest("ada", LETTERS));

    const marked = unwrap(service.setLogisticsRequestStatus(request.id, "completed", "zhijing"));

    expect(marked).toMatchObject({
      confirmed_by: "zhijing",
      confirmed_by_name: "Zhijing Jin",
      confirmed_via: "admin",
    });
    expect(service.undoLetterConfirmation(request.id, "ada")).toMatchObject({
      ok: false,
      status: 409,
    });

    // An admin moving it back clears who confirmed it.
    const reopened = unwrap(
      service.setLogisticsRequestStatus(request.id, "in_progress", "zhijing"),
    );
    expect(reopened.confirmed_by).toBeUndefined();
  });
});
