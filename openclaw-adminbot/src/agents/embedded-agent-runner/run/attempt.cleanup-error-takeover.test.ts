// Characterization coverage for the teardown error-precedence helpers extracted from attempt.ts.
import { describe, expect, it } from "vitest";
import {
  EmbeddedAttemptPromptErrorWithCleanupTakeoverError,
  shouldPreservePromptErrorAfterCleanupError,
  toLintErrorObject,
} from "./attempt.cleanup-error-takeover.js";
import { EmbeddedAttemptSessionTakeoverError } from "./attempt.session-lock.js";

describe("shouldPreservePromptErrorAfterCleanupError", () => {
  it("preserves the prompt error only when cleanup failed with a takeover", () => {
    const takeover = new EmbeddedAttemptSessionTakeoverError("taken over");

    expect(
      shouldPreservePromptErrorAfterCleanupError({
        promptError: new Error("prompt"),
        cleanupError: takeover,
      }),
    ).toBe(true);
    expect(
      shouldPreservePromptErrorAfterCleanupError({
        promptError: new Error("prompt"),
        cleanupError: new Error("other"),
      }),
    ).toBe(false);
    expect(
      shouldPreservePromptErrorAfterCleanupError({ promptError: null, cleanupError: takeover }),
    ).toBe(false);
  });
});

describe("EmbeddedAttemptPromptErrorWithCleanupTakeoverError", () => {
  it("reports the prompt error's message under the takeover's name and keeps both causes", () => {
    // Callers match on the takeover name, so the combined error must impersonate it
    // while still carrying the original prompt failure.
    const promptError = new Error("prompt blew up");
    const cleanupError = new EmbeddedAttemptSessionTakeoverError("taken over");

    const combined = new EmbeddedAttemptPromptErrorWithCleanupTakeoverError({
      promptError,
      cleanupError,
    });

    expect(combined.name).toBe("EmbeddedAttemptSessionTakeoverError");
    expect(combined.message).toBe("prompt blew up");
    expect(combined.cause).toBe(cleanupError);
    expect(combined.promptError).toBe(promptError);
    expect(combined.cleanupError).toBe(cleanupError);
  });
});

describe("toLintErrorObject", () => {
  it("passes an Error through untouched", () => {
    const error = new Error("boom");
    expect(toLintErrorObject(error, "fallback")).toBe(error);
  });

  it("wraps a string as its own message", () => {
    expect(toLintErrorObject("plain", "fallback").message).toBe("plain");
  });

  it("uses the fallback message and copies own properties for object values", () => {
    const value = { code: "E_LINT", detail: "bad" };
    const error = toLintErrorObject(value, "fallback");

    expect(error.message).toBe("fallback");
    expect(error.cause).toBe(value);
    expect((error as unknown as { code: string }).code).toBe("E_LINT");
  });

  it("keeps the raw value as cause for primitives without copying properties", () => {
    const error = toLintErrorObject(42, "fallback");

    expect(error.message).toBe("fallback");
    expect(error.cause).toBe(42);
  });
});
