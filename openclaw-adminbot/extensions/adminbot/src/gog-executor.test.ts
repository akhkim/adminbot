import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "./contracts.js";
import { createGogAdminBotExecutor } from "./gog-executor.js";
import { AdminBotService } from "./service-core.js";

function proposal(
  type: AdminBotStoredProposal["type"],
  proposedPayload: Record<string, unknown>,
): AdminBotStoredProposal {
  const result = new AdminBotService().createProposal({
    type,
    summary: `Test ${type}`,
    proposed_payload: proposedPayload,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

describe("createGogAdminBotExecutor", () => {
  it("maps approved email sends to a non-interactive exact gog command", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await expect(
      executor.execute(
        proposal("email.send", {
          account: "lab@example.com",
          to: ["one@example.com", "two@example.com"],
          subject: "Lab update",
          body: "The draft was approved.",
        }),
      ),
    ).resolves.toEqual({ handled: true });

    expect(run).toHaveBeenCalledWith([
      "--json",
      "--no-input",
      "--enable-commands-exact",
      "gmail.send",
      "--account",
      "lab@example.com",
      "gmail",
      "send",
      "--to",
      "one@example.com,two@example.com",
      "--subject",
      "Lab update",
      "--body",
      "The draft was approved.",
    ]);
  });

  it("maps calendar invites and cancellations with explicit notifications", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await executor.execute(
      proposal("calendar.send_invite", {
        summary: "Paper review",
        from: "2026-06-22T14:00:00-04:00",
        to: "2026-06-22T14:30:00-04:00",
        attendees: ["reviewer@example.com"],
      }),
    );
    await executor.execute(
      proposal("calendar.cancel", {
        calendar_id: "primary",
        event_id: "event-1",
      }),
    );

    expect(run.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["calendar.create", "--send-updates", "all"]),
    );
    expect(run.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["calendar.delete", "--force", "event-1", "--send-updates", "all"]),
    );
  });

  it("rejects incomplete gog payloads and declines unrelated actions", async () => {
    const run = vi.fn(async () => {});
    const executor = createGogAdminBotExecutor({ run });

    await expect(
      executor.execute(proposal("email.send", { to: "one@example.com" })),
    ).rejects.toThrow("proposed_payload.subject is required");
    await expect(
      executor.execute(proposal("slack.send_message", { message: "hello" })),
    ).resolves.toEqual({ handled: false });
    expect(run).not.toHaveBeenCalled();
  });
});
