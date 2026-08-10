// Characterization coverage for the no-real-conversation compaction predicate extracted from run.ts.
// resetNoRealConversationTokenSnapshot needs a session-store harness and stays covered
// through the full runner.
import { describe, expect, it } from "vitest";
import {
  isNoRealConversationCompactionNoop,
  NO_REAL_CONVERSATION_MESSAGES_REASON,
} from "./run.no-real-conversation.js";

describe("isNoRealConversationCompactionNoop", () => {
  const noop = {
    ok: true,
    compacted: false,
    reason: NO_REAL_CONVERSATION_MESSAGES_REASON,
  };

  it("matches only a successful compaction that compacted nothing for this reason", () => {
    expect(isNoRealConversationCompactionNoop(noop)).toBe(true);
  });

  it("does not match a failed compaction, a real compaction, or another reason", () => {
    expect(isNoRealConversationCompactionNoop({ ...noop, ok: false })).toBe(false);
    expect(isNoRealConversationCompactionNoop({ ...noop, compacted: true })).toBe(false);
    expect(isNoRealConversationCompactionNoop({ ...noop, reason: "context overflow" })).toBe(false);
  });

  it("requires the flags to be present, not merely falsy-absent", () => {
    expect(isNoRealConversationCompactionNoop({})).toBe(false);
    expect(isNoRealConversationCompactionNoop({ ok: true, compacted: false })).toBe(false);
  });
});
