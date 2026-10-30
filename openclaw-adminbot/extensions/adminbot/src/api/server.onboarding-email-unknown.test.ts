import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAdminBotOnboardingSender } from "../workflows/onboarding/guide-sender.js";
import { createAdminBotMockService } from "./server.js";

describe("durable onboarding email attempts", () => {
  it("never resends an accepted-then-timed-out email, including after database reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adminbot-mail-unknown-"));
    const sendEmail = vi.fn(async () => {
      throw new Error("provider accepted, response timed out");
    });
    const sender = createAdminBotOnboardingSender({
      env: { ADMINBOT_CONTACT_EMAILS: "help@example.test" },
      sendEmail,
    });
    const options = {
      databasePath: join(dir, "state.sqlite"),
      onboardingSender: sender,
      calendarInviteRunner: async () => {},
    };
    let mock = createAdminBotMockService(options);
    try {
      const proposal = mock.service.createProposal({
        type: "onboarding.send_guide",
        summary: "Synthetic welcome",
        proposed_payload: { template_id: "welcome", name: "Ada", email: "ada@example.test" },
      });
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) {
        throw new Error(proposal.error.message);
      }
      const id = proposal.payload.id;
      expect(
        mock.service.approve(id, {
          approver_id: "synthetic-admin",
          approver_role: "admin",
          payload_hash: proposal.payload.payload_hash,
        }).ok,
      ).toBe(true);
      const first = await mock.service.execute(id, {
        dry_run: false,
        idempotency_key: "first-attempt",
      });
      expect(first).toMatchObject({ ok: false });
      if (!first.ok) {
        expect(first.error.message).toContain("delivery is unknown");
      }
      expect(sendEmail).toHaveBeenCalledOnce();
      expect(
        (await mock.service.execute(id, { dry_run: false, idempotency_key: "second-attempt" })).ok,
      ).toBe(false);
      expect(sendEmail).toHaveBeenCalledOnce();
      mock.close();
      mock = createAdminBotMockService(options);
      const replay = await mock.service.execute(id, {
        dry_run: false,
        idempotency_key: "after-reopen",
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.error.message).toContain("reconcile provider receipts");
      }
      expect(sendEmail).toHaveBeenCalledOnce();
    } finally {
      mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not claim an email attempt for a preflight refusal", async () => {
    const sender = createAdminBotOnboardingSender({ env: {}, sendEmail: vi.fn() });
    const before = vi.fn();
    const refused = await sender({
      template_id: "welcome",
      name: "Ada",
      email: "ada@example.test",
      before_email: before,
    });
    expect(refused.ok).toBe(false);
    expect(before).not.toHaveBeenCalled();
  });
});
