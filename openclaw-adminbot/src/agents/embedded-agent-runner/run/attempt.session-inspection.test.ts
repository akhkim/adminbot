// Characterization coverage for the session-inspection helpers extracted from attempt.ts.
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import {
  cloneHookMessages,
  flushSessionManagerFile,
  sessionMessagesContainIdempotencyKey,
  summarizeMessagePayload,
  summarizeSessionContext,
} from "./attempt.session-inspection.js";

const message = (value: unknown): AgentMessage => value as AgentMessage;

describe("summarizeMessagePayload", () => {
  it("counts a plain string body as text chars with no image blocks", () => {
    expect(summarizeMessagePayload(message({ role: "user", content: "hello" }))).toEqual({
      textChars: 5,
      imageBlocks: 0,
    });
  });

  it("sums text blocks and counts image blocks separately", () => {
    const result = summarizeMessagePayload(
      message({
        role: "user",
        content: [
          { type: "text", text: "abc" },
          { type: "image", source: {} },
          { type: "text", text: "de" },
          { type: "image", source: {} },
        ],
      }),
    );

    expect(result).toEqual({ textChars: 5, imageBlocks: 2 });
  });

  it("ignores non-object blocks and blocks without string text", () => {
    const result = summarizeMessagePayload(
      message({ role: "user", content: [null, 7, { type: "text" }, { type: "text", text: "ok" }] }),
    );

    expect(result).toEqual({ textChars: 2, imageBlocks: 0 });
  });

  it("treats a non-string, non-array body as empty rather than throwing", () => {
    expect(summarizeMessagePayload(message({ role: "user", content: { text: "x" } }))).toEqual({
      textChars: 0,
      imageBlocks: 0,
    });
  });
});

describe("summarizeSessionContext", () => {
  it("reports role counts sorted by role name with running text/image totals", () => {
    const result = summarizeSessionContext([
      message({ role: "user", content: "hello" }),
      message({ role: "assistant", content: "hi" }),
      message({ role: "user", content: [{ type: "image", source: {} }] }),
    ]);

    expect(result).toEqual({
      roleCounts: "assistant:1,user:2",
      totalTextChars: 7,
      totalImageBlocks: 1,
      maxMessageTextChars: 5,
    });
  });

  it("labels a missing role as unknown and reports 'none' for an empty transcript", () => {
    expect(summarizeSessionContext([message({ content: "x" })]).roleCounts).toBe("unknown:1");
    expect(summarizeSessionContext([]).roleCounts).toBe("none");
  });
});

describe("cloneHookMessages", () => {
  it("deep-copies so hook mutations cannot reach the original messages", () => {
    const original = message({ role: "user", content: [{ type: "text", text: "keep" }] });
    const [copy] = cloneHookMessages([original]);

    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    (copy as { content: { text: string }[] }).content[0].text = "changed";
    expect((original as unknown as { content: { text: string }[] }).content[0].text).toBe("keep");
  });
});

describe("sessionMessagesContainIdempotencyKey", () => {
  it("matches only a string idempotencyKey equal to the probe", () => {
    const messages = [message({ role: "user", idempotencyKey: "abc" })];

    expect(sessionMessagesContainIdempotencyKey(messages, "abc")).toBe(true);
    expect(sessionMessagesContainIdempotencyKey(messages, "other")).toBe(false);
    expect(sessionMessagesContainIdempotencyKey([message({ role: "user" })], "abc")).toBe(false);
  });
});

describe("flushSessionManagerFile", () => {
  it("calls rewriteFile when present and stays a no-op when it is not", () => {
    let calls = 0;
    const manager = {
      rewriteFile: () => {
        calls++;
      },
    };

    flushSessionManagerFile(manager as never);
    expect(calls).toBe(1);

    expect(() => flushSessionManagerFile({} as never)).not.toThrow();
  });
});
