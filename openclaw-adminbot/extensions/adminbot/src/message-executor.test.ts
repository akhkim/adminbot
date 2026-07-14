import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "./contracts.js";
import { createAdminBotMessageExecutor } from "./message-executor.js";
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

describe("createAdminBotMessageExecutor", () => {
  it("maps paper nudge proposals to the OpenClaw message send CLI", async () => {
    const run = vi.fn(async () => {});
    const executor = createAdminBotMessageExecutor({
      commandArgsPrefix: ["openclaw.mjs"],
      run,
    });

    await expect(
      executor.execute(
        proposal("paper_publish.nudge_author", {
          tool: "message",
          action: "send",
          channel: "slack",
          target: "user:U123",
          message: "Please nudge the authors.",
        }),
      ),
    ).resolves.toEqual({ handled: true });

    expect(run).toHaveBeenCalledWith([
      "openclaw.mjs",
      "message",
      "send",
      "--channel",
      "slack",
      "--target",
      "user:U123",
      "--message",
      "Please nudge the authors.",
      "--json",
    ]);
  });

  it("declines unrelated actions and rejects incomplete message payloads", async () => {
    const run = vi.fn(async () => {});
    const executor = createAdminBotMessageExecutor({ run });

    await expect(executor.execute(proposal("email.send", { message: "hello" }))).resolves.toEqual({
      handled: false,
    });
    await expect(
      executor.execute(proposal("slack.send_message", { target: "user:U123" })),
    ).rejects.toThrow("proposed_payload.message is required");
    expect(run).not.toHaveBeenCalled();
  });
});
