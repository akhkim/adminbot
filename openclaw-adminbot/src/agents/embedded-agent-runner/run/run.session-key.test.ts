// Characterization coverage for the sessionKey backfill short circuits extracted from run.ts.
// The resolve path itself needs a config + session-store harness and stays covered through
// the full runner; only the no-lookup-needed branches are pinned here.
import { describe, expect, it } from "vitest";
import { backfillSessionKey } from "./run.session-key.js";

describe("backfillSessionKey", () => {
  it("returns the caller's key, trimmed, without consulting config", () => {
    expect(backfillSessionKey({ config: undefined, sessionId: "s1", sessionKey: "  key  " })).toBe(
      "key",
    );
  });

  it("treats a whitespace-only key as absent", () => {
    expect(backfillSessionKey({ config: undefined, sessionId: "s1", sessionKey: "   " })).toBe(
      undefined,
    );
  });

  it("returns undefined when there is nothing to look a key up from", () => {
    expect(backfillSessionKey({ config: undefined, sessionId: "s1" })).toBeUndefined();
    expect(backfillSessionKey({ config: {}, sessionId: "" })).toBeUndefined();
  });
});
