// Characterization coverage for the mid-turn repair helpers extracted from attempt.ts.
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import {
  hasVisiblePendingToolMediaReply,
  isMidTurnPrecheckAssistantError,
  removeTrailingMidTurnPrecheckAssistantError,
} from "./attempt.turn-repair.js";
import { MID_TURN_PRECHECK_ERROR_MESSAGE } from "./midturn-precheck.js";

const message = (value: unknown): AgentMessage => value as AgentMessage;

const precheckError = () =>
  message({
    role: "assistant",
    stopReason: "error",
    errorMessage: MID_TURN_PRECHECK_ERROR_MESSAGE,
  });

describe("hasVisiblePendingToolMediaReply", () => {
  it("is true only for a non-blank media url or an explicit voice flag", () => {
    expect(hasVisiblePendingToolMediaReply({ mediaUrls: ["https://x/y.png"] })).toBe(true);
    expect(hasVisiblePendingToolMediaReply({ audioAsVoice: true })).toBe(true);
    expect(hasVisiblePendingToolMediaReply({ mediaUrls: ["", "  "] })).toBe(false);
    expect(hasVisiblePendingToolMediaReply({ mediaUrls: [] })).toBe(false);
    expect(hasVisiblePendingToolMediaReply(null)).toBe(false);
    expect(hasVisiblePendingToolMediaReply(undefined)).toBe(false);
  });
});

describe("isMidTurnPrecheckAssistantError", () => {
  it("matches only an assistant error carrying the precheck error message", () => {
    expect(isMidTurnPrecheckAssistantError(precheckError())).toBe(true);
    expect(isMidTurnPrecheckAssistantError(undefined)).toBe(false);
    expect(
      isMidTurnPrecheckAssistantError(
        message({
          role: "user",
          stopReason: "error",
          errorMessage: MID_TURN_PRECHECK_ERROR_MESSAGE,
        }),
      ),
    ).toBe(false);
    expect(
      isMidTurnPrecheckAssistantError(
        message({
          role: "assistant",
          stopReason: "end_turn",
          errorMessage: MID_TURN_PRECHECK_ERROR_MESSAGE,
        }),
      ),
    ).toBe(false);
    expect(
      isMidTurnPrecheckAssistantError(
        message({ role: "assistant", stopReason: "error", errorMessage: "something else" }),
      ),
    ).toBe(false);
  });
});

describe("removeTrailingMidTurnPrecheckAssistantError", () => {
  const sessionManagerStub = (removed: number) => ({
    removeTrailingEntries: () => removed,
  });

  it("drops a trailing precheck error from the active session", () => {
    const activeSession = {
      agent: { state: { messages: [message({ role: "user", content: "hi" }), precheckError()] } },
    };

    removeTrailingMidTurnPrecheckAssistantError({
      activeSession,
      sessionManager: sessionManagerStub(1) as never,
    });

    expect(activeSession.agent.state.messages).toHaveLength(1);
  });

  it("leaves the transcript alone when the last message is not a precheck error", () => {
    const messages = [message({ role: "assistant", content: "done" })];
    const activeSession = { agent: { state: { messages } } };

    removeTrailingMidTurnPrecheckAssistantError({
      activeSession,
      sessionManager: sessionManagerStub(0) as never,
    });

    expect(activeSession.agent.state.messages).toBe(messages);
  });

  it("still removes the active error when no persisted entry matched", () => {
    // The mismatch is only logged; the in-memory removal must not be rolled back.
    const activeSession = { agent: { state: { messages: [precheckError()] } } };

    removeTrailingMidTurnPrecheckAssistantError({
      activeSession,
      sessionManager: sessionManagerStub(0) as never,
    });

    expect(activeSession.agent.state.messages).toHaveLength(0);
  });
});
