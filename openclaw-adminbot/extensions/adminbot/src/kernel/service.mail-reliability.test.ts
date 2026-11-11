// Mail and nudge reliability at the service boundary, driven through the real gog capture (retry,
// classification, error formatting) with a fake process in place of the gog binary. No test here
// shells out or sends anything; every address is synthetic.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGogAdminBotExecutor, createGogCaptureWith } from "../connectors/gog.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

/** What execFile rejects with when gog exits non-zero. The message carries the whole command. */
function gogExit(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("Command failed: gog gmail send --body <synthetic body>"), {
    code: 1,
    stderr,
    ...extra,
  });
}

const UNREACHABLE = "dial tcp: lookup gmail.googleapis.com: no such host";
const EXPIRED_TOKEN =
  'oauth2: cannot fetch token: 400 Bad Request Response: {"error":"invalid_grant","error_description":"Token has been expired or revoked."}';

type Exec = (executable: string, args: string[]) => Promise<{ stdout: string }>;

function mailLab(exec: Exec) {
  const store = new AdminBotMemoryStore();
  const execSpy = vi.fn(exec);
  const sleeps: number[] = [];
  const capture = createGogCaptureWith({
    env: {},
    exec: execSpy,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const executor = createGogAdminBotExecutor({
    run: async (args) => {
      await capture(args);
    },
    capture,
  });
  const service = new AdminBotService(store, { executor });
  unwrap(
    service.upsertLabMember({
      id: "boss",
      name: "Admin Person",
      privilege_level: "admin",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Example",
      privilege_level: "member",
      email: "ada@example.org",
      receives_nudges: true,
    } as never),
  );
  const nudgeAda = () =>
    service.sendMemberNudge(
      {
        channel: "email",
        recipient_member_ids: ["ada"],
        subject: "Synthetic reminder",
        message: "Please fill in the synthetic form.",
      },
      "cron",
    );
  return { store, service, exec: execSpy, sleeps, nudgeAda };
}

describe("mail send retry", () => {
  it("retries a send that never reached Google, then records it once it goes out", async () => {
    let calls = 0;
    const { store, exec, sleeps, nudgeAda } = mailLab(async () => {
      calls += 1;
      if (calls === 1) {
        throw gogExit(UNREACHABLE);
      }
      return { stdout: "{}" };
    });

    const result = unwrap(await nudgeAda());

    expect(exec).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
    expect(result.deliveries).toEqual([
      expect.objectContaining({ member_id: "ada", outcome: "executed" }),
    ]);
    const actionId = result.deliveries?.[0]?.action_id ?? "";
    expect(store.getProposal(actionId)?.status).toBe("executed");
    expect(store.getExecutionResult(actionId)).toBeDefined();
  });

  it("surfaces an expired Google token to admins at once and does not mark the send done", async () => {
    const { store, service, exec, nudgeAda } = mailLab(async () => {
      throw gogExit(EXPIRED_TOKEN);
    });

    const result = unwrap(await nudgeAda());

    // No retry: no amount of trying fixes a revoked token.
    expect(exec).toHaveBeenCalledTimes(1);
    // The request never left, so this is a plain failure, not an "unknown" to reconcile.
    expect(result.deliveries).toEqual([
      expect.objectContaining({ member_id: "ada", outcome: "failed" }),
    ]);
    expect(result.deliveries?.[0]?.reason).toContain("gog auth add");
    const actionId = result.deliveries?.[0]?.action_id ?? "";
    expect(store.getProposal(actionId)?.status).not.toBe("executed");
    expect(store.getExecutionResult(actionId)).toBeUndefined();

    // Admins hear about it from the failure itself, not a day later from a health pass.
    const alerts = store
      .listMemberNotifications("boss")
      .filter((notification) => notification.kind === "automation");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toContain("Google credentials");
    expect(alerts[0]?.body).toContain("gog auth add");
    expect(unwrap(service.automationHealth()).issues.map((issue) => issue.kind)).toEqual([
      "google_credentials",
    ]);

    // A second failure in the same week does not repeat the alert.
    await nudgeAda();
    expect(
      store
        .listMemberNotifications("boss")
        .filter((notification) => notification.kind === "automation"),
    ).toHaveLength(1);
  });

  it("clears the credential issue once a gog-backed send succeeds again", async () => {
    let broken = true;
    const { store, service, nudgeAda } = mailLab(async () => {
      if (broken) {
        throw gogExit(EXPIRED_TOKEN);
      }
      return { stdout: "{}" };
    });
    await nudgeAda();
    expect(unwrap(service.automationHealth()).issues).toHaveLength(1);

    broken = false;
    // A re-authorized host: a plain email.send through the same executor goes out.
    const proposal = unwrap(
      service.createProposal({
        type: "email.send",
        summary: "Synthetic follow-up",
        proposed_payload: {
          to: "ada@example.org",
          subject: "Synthetic",
          body: "Synthetic body.",
        },
      }),
    );
    unwrap(
      service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "admin",
        approver_id: "boss",
      } as never),
    );
    unwrap(await service.execute(proposal.id, { dry_run: false }));

    expect(unwrap(service.automationHealth()).issues).toEqual([]);
    expect(store.getExecutionResult(proposal.id)).toBeDefined();
  });
});

describe("no double send", () => {
  it("does not retry a send that timed out, since it may already be in the inbox", async () => {
    const { exec, nudgeAda } = mailLab(async () => {
      throw gogExit("", { code: null, killed: true, signal: "SIGTERM" });
    });

    const result = unwrap(await nudgeAda());

    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.deliveries).toEqual([
      expect.objectContaining({ member_id: "ada", outcome: "unknown" }),
    ]);
  });

  it("does not retry a Gmail 5xx or a reset connection mid-request", async () => {
    for (const stderr of [
      "Google API error (500 backendError): Backend Error",
      "read tcp 10.0.0.2:51234->142.250.0.1:443: read: connection reset by peer",
    ]) {
      const { exec, nudgeAda } = mailLab(async () => {
        throw gogExit(stderr);
      });
      await nudgeAda();
      expect(exec).toHaveBeenCalledTimes(1);
    }
  });

  it("replays a re-executed send from the ledger instead of mailing again", async () => {
    const { service, exec, nudgeAda } = mailLab(async () => ({ stdout: "{}" }));
    const result = unwrap(await nudgeAda());
    const actionId = result.deliveries?.[0]?.action_id ?? "";
    expect(exec).toHaveBeenCalledTimes(1);

    const again = await service.execute(actionId, { dry_run: false });
    expect(again.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

/**
 * The paperflow stage sweep is the email follow-up cadence: one mail per stage per week while the
 * stage stays open, up to a cap. It runs on wall-clock time, so these tests move the clock (Date
 * only) and use a plain executor rather than the gog capture, whose pacing timer reads the clock
 * too.
 */
describe("follow-up nudges", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stageLab(execute: () => Promise<{ handled: boolean }>) {
    const executor = { execute: vi.fn(execute) };
    const service = new AdminBotService(undefined, {
      paperflowBotEmail: "adminbot@example.org",
      executor,
    });
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "rahul",
        name: "Synthetic Author",
        privilege_level: "member",
        email: "author@example.org",
      } as never),
    );
    unwrap(
      service.upsertPaper({
        id: "p1",
        title: "Synthetic Paper",
        authors: ["Synthetic Author"],
        current_step: "submission",
      }),
    );
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "submission",
        input: { url: "https://openreview.net/forum?id=synthetic" },
        memberId: "rahul",
        privileged: true,
      }),
    );
    return { service, executor };
  }

  it("asks again while the stage is still open, and stops at the cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-03-02T09:00:00.000Z");
    vi.setSystemTime(start);
    const { service, executor } = stageLab(async () => ({ handled: true }));

    unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // Same week: nothing.
    vi.setSystemTime(start + 3 * DAY_MS);
    unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // A week on and nobody has answered: the follow-up goes out.
    vi.setSystemTime(start + 8 * DAY_MS);
    const followUp = unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(followUp.created).toHaveLength(1);
    expect(service.listNudgeLedgerForTest("paperflow_stage")[0]).toMatchObject({
      subject_id: "p1:reviews_out",
      nudge_count: 2,
    });

    vi.setSystemTime(start + 16 * DAY_MS);
    unwrap(await service.sendPaperflowStageNudges("cron"));
    vi.setSystemTime(start + 24 * DAY_MS);
    unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(executor.execute).toHaveBeenCalledTimes(4);

    // Four unanswered mails: the sweep stops and reports the stage instead of sending a fifth.
    vi.setSystemTime(start + 32 * DAY_MS);
    const capped = unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(executor.execute).toHaveBeenCalledTimes(4);
    expect(capped.exhausted).toEqual(["p1:reviews_out"]);
    const { items } = unwrap(service.collectPaperflowStageNudges());
    expect(items[0]).toMatchObject({ due: false, exhausted: true, nudge_count: 4 });
  });

  it("does not count a send that failed, so the next pass tries again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-03-02T09:00:00.000Z"));
    let broken = true;
    const { service, executor } = stageLab(async () => {
      if (broken) {
        throw new Error(
          "gog credentials were rejected; re-run `gog auth add` on the AdminBot host: invalid_grant",
        );
      }
      return { handled: true };
    });

    const failed = unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(failed.created).toEqual([]);
    expect(failed.skipped).toEqual([
      expect.objectContaining({
        member_id: "rahul",
        reason: expect.stringContaining("gog auth add"),
      }),
    ]);
    expect(service.listNudgeLedgerForTest("paperflow_stage")).toEqual([]);

    broken = false;
    unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(service.listNudgeLedgerForTest("paperflow_stage")[0]).toMatchObject({
      nudge_count: 1,
    });
  });

  // The ledger is not stamped on a failed send, so every pass retries -- and every retry used to
  // file another identical portal card while the mail credentials stayed broken.
  it("files one portal notification per follow-up while the send keeps failing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-03-02T09:00:00.000Z");
    vi.setSystemTime(start);
    let broken = true;
    const { service } = stageLab(async () => {
      if (broken) {
        throw new Error(
          "gog credentials were rejected; re-run `gog auth add` on the AdminBot host: invalid_grant",
        );
      }
      return { handled: true };
    });
    const cards = () =>
      unwrap(service.listMemberNotifications("rahul")).notifications.filter(
        (notification) => !notification.resolved_at,
      );

    for (let day = 0; day < 3; day += 1) {
      vi.setSystemTime(start + day * DAY_MS);
      unwrap(await service.sendPaperflowStageNudges("cron"));
    }
    expect(cards()).toHaveLength(1);

    // Mail works again: the first send goes out against the card already filed, and the next
    // week's follow-up -- different text, one more ask counted -- gets a card of its own.
    broken = false;
    unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(cards()).toHaveLength(1);
    vi.setSystemTime(start + 10 * DAY_MS);
    unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(cards()).toHaveLength(2);
  });

  it("does not count a kill-switched send as a nudge", async () => {
    const { service } = stageLab(async () => ({ handled: true, delivered: false }) as never);
    unwrap(await service.sendPaperflowStageNudges("cron"));
    expect(service.listNudgeLedgerForTest("paperflow_stage")).toEqual([]);
    expect(unwrap(service.collectPaperflowStageNudges()).items[0]).toMatchObject({ due: true });
  });
});
