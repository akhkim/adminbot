// Characterization coverage for the attempt-result normalization extracted from run.ts.
import { describe, expect, it } from "vitest";
import {
  buildTraceToolSummary,
  hasCompletedModelProgressForIdleBreaker,
  normalizeEmbeddedRunAttemptResult,
  type EmbeddedRunAttemptForRunner,
} from "./run.attempt-result.js";

const attempt = (value: unknown): EmbeddedRunAttemptForRunner =>
  value as EmbeddedRunAttemptForRunner;

describe("normalizeEmbeddedRunAttemptResult", () => {
  it("turns every null or absent collection into an empty one", () => {
    const normalized = normalizeEmbeddedRunAttemptResult(
      attempt({ assistantTexts: null, toolMetas: undefined }),
    );
    expect(normalized.assistantTexts).toEqual([]);
    expect(normalized.toolMetas).toEqual([]);
    expect(normalized.acceptedSessionSpawns).toEqual([]);
    expect(normalized.messagesSnapshot).toEqual([]);
    expect(normalized.messagingToolSentTexts).toEqual([]);
    expect(normalized.messagingToolSentMediaUrls).toEqual([]);
    expect(normalized.messagingToolSentTargets).toEqual([]);
    expect(normalized.messagingToolSourceReplyPayloads).toEqual([]);
  });

  it("defaults the item lifecycle to all-zero counters", () => {
    expect(normalizeEmbeddedRunAttemptResult(attempt({})).itemLifecycle).toEqual({
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    });
  });

  it("coerces didDeliverSourceReplyViaMessageTool to a strict boolean", () => {
    expect(
      normalizeEmbeddedRunAttemptResult(attempt({ didDeliverSourceReplyViaMessageTool: null }))
        .didDeliverSourceReplyViaMessageTool,
    ).toBe(false);
    expect(
      normalizeEmbeddedRunAttemptResult(attempt({ didDeliverSourceReplyViaMessageTool: 1 }))
        .didDeliverSourceReplyViaMessageTool,
    ).toBe(false);
    expect(
      normalizeEmbeddedRunAttemptResult(attempt({ didDeliverSourceReplyViaMessageTool: true }))
        .didDeliverSourceReplyViaMessageTool,
    ).toBe(true);
  });

  it("keeps values the backend did supply and carries unrelated fields through", () => {
    const normalized = normalizeEmbeddedRunAttemptResult(
      attempt({ assistantTexts: ["hi"], someOtherField: "kept" }),
    );
    expect(normalized.assistantTexts).toEqual(["hi"]);
    expect((normalized as unknown as { someOtherField?: string }).someOtherField).toBe("kept");
  });

  it("always fills replayMetadata, falling back when the attempt carried none", () => {
    expect(normalizeEmbeddedRunAttemptResult(attempt({})).replayMetadata).toBeDefined();
    const supplied = { replayInvalid: false } as never;
    expect(
      normalizeEmbeddedRunAttemptResult(attempt({ replayMetadata: supplied })).replayMetadata,
    ).toBe(supplied);
  });
});

describe("hasCompletedModelProgressForIdleBreaker", () => {
  const base = () =>
    attempt({
      assistantTexts: [],
      toolMetas: [],
      clientToolCalls: [],
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    });

  it("is false when nothing observable happened", () => {
    expect(hasCompletedModelProgressForIdleBreaker(base())).toBe(false);
  });

  it("ignores assistant text that is only whitespace", () => {
    expect(
      hasCompletedModelProgressForIdleBreaker(attempt({ ...base(), assistantTexts: ["   ", ""] })),
    ).toBe(false);
    expect(
      hasCompletedModelProgressForIdleBreaker(attempt({ ...base(), assistantTexts: ["done"] })),
    ).toBe(true);
  });

  it("counts a tool call, a client tool call, or a completed item as progress", () => {
    expect(
      hasCompletedModelProgressForIdleBreaker(
        attempt({ ...base(), toolMetas: [{ toolName: "bash" }] }),
      ),
    ).toBe(true);
    expect(
      hasCompletedModelProgressForIdleBreaker(attempt({ ...base(), clientToolCalls: [{}] })),
    ).toBe(true);
    expect(
      hasCompletedModelProgressForIdleBreaker(
        attempt({
          ...base(),
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("tolerates an absent clientToolCalls list", () => {
    expect(
      hasCompletedModelProgressForIdleBreaker(attempt({ ...base(), clientToolCalls: undefined })),
    ).toBe(false);
  });
});

describe("buildTraceToolSummary", () => {
  it("returns undefined when no tool ran", () => {
    expect(buildTraceToolSummary({ hadFailure: false })).toBeUndefined();
    expect(buildTraceToolSummary({ toolMetas: [], hadFailure: true })).toBeUndefined();
  });

  it("counts every call but lists each tool name once, in first-seen order", () => {
    expect(
      buildTraceToolSummary({
        toolMetas: [{ toolName: "read" }, { toolName: "bash" }, { toolName: "read" }],
        hadFailure: false,
      }),
    ).toEqual({ calls: 3, tools: ["read", "bash"], failures: 0 });
  });

  it("skips blank tool names without dropping their call from the count", () => {
    expect(
      buildTraceToolSummary({
        toolMetas: [{ toolName: "  " }, { toolName: "bash" }],
        hadFailure: true,
      }),
    ).toEqual({ calls: 2, tools: ["bash"], failures: 1 });
  });

  it("reports failures as a 0/1 flag rather than a failure count", () => {
    expect(
      buildTraceToolSummary({
        toolMetas: [{ toolName: "a" }, { toolName: "b" }],
        hadFailure: true,
      }).failures,
    ).toBe(1);
  });
});
