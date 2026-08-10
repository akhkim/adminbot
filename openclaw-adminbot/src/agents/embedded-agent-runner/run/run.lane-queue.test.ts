// Characterization coverage for the lane-enqueue helpers extracted from run.ts.
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
  resolveEmbeddedRunSessionQueuePriority,
  withEmbeddedRunLaneTimeout,
} from "./run.lane-queue.js";

describe("resolveEmbeddedRunLaneTimeoutMs", () => {
  it("adds the grace window to a positive finite timeout", () => {
    expect(resolveEmbeddedRunLaneTimeoutMs(1_000)).toBe(1_000 + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS);
  });

  it("floors a fractional timeout before adding the grace window", () => {
    expect(resolveEmbeddedRunLaneTimeoutMs(1_000.9)).toBe(
      1_000 + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
  });

  it("returns undefined for a non-positive or non-finite timeout", () => {
    expect(resolveEmbeddedRunLaneTimeoutMs(0)).toBeUndefined();
    expect(resolveEmbeddedRunLaneTimeoutMs(-1)).toBeUndefined();
    expect(resolveEmbeddedRunLaneTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(resolveEmbeddedRunLaneTimeoutMs(Number.NaN)).toBeUndefined();
  });
});

describe("withEmbeddedRunLaneTimeout", () => {
  it("fills in the lane timeout when the caller did not set one", () => {
    expect(withEmbeddedRunLaneTimeout({ priority: "normal" }, 500)).toEqual({
      priority: "normal",
      taskTimeoutMs: 500,
    });
    expect(withEmbeddedRunLaneTimeout(undefined, 500)).toEqual({ taskTimeoutMs: 500 });
  });

  it("never overrides a caller-supplied taskTimeoutMs", () => {
    const opts = { taskTimeoutMs: 10 };
    expect(withEmbeddedRunLaneTimeout(opts, 500)).toBe(opts);
  });

  it("passes the options through untouched when there is no lane timeout", () => {
    const opts = { priority: "normal" } as const;
    expect(withEmbeddedRunLaneTimeout(opts, undefined)).toBe(opts);
    expect(withEmbeddedRunLaneTimeout(undefined, undefined)).toBeUndefined();
  });
});

describe("resolveEmbeddedRunSessionQueuePriority", () => {
  it("puts interactive triggers in the foreground", () => {
    expect(resolveEmbeddedRunSessionQueuePriority("user")).toBe("foreground");
    expect(resolveEmbeddedRunSessionQueuePriority("manual")).toBe("foreground");
  });

  it("puts automated triggers in the background", () => {
    for (const trigger of ["cron", "heartbeat", "memory", "overflow"] as const) {
      expect(resolveEmbeddedRunSessionQueuePriority(trigger)).toBe("background");
    }
  });

  it("falls back to normal for an unlisted or absent trigger", () => {
    expect(resolveEmbeddedRunSessionQueuePriority(undefined)).toBe("normal");
  });
});
