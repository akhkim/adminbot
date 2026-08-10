// Characterization coverage for the hook/prompt outcome coercions extracted from run.ts.
import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { buildHandledReplyPayloads, toLintErrorObject } from "./run.hook-outcomes.js";

describe("buildHandledReplyPayloads", () => {
  it("emits the silent token when the hook handled the turn without a reply", () => {
    expect(buildHandledReplyPayloads()).toEqual([
      {
        text: SILENT_REPLY_TOKEN,
        mediaUrl: undefined,
        mediaUrls: undefined,
        replyToId: undefined,
        audioAsVoice: undefined,
        isError: undefined,
        isReasoning: undefined,
      },
    ]);
  });

  it("copies exactly the seven forwarded fields and drops anything else", () => {
    const [payload] = buildHandledReplyPayloads({
      text: "hi",
      mediaUrls: ["https://x/y.png"],
      audioAsVoice: true,
      isError: false,
      extra: "dropped",
    } as never);
    expect(payload).toEqual({
      text: "hi",
      mediaUrl: undefined,
      mediaUrls: ["https://x/y.png"],
      replyToId: undefined,
      audioAsVoice: true,
      isError: false,
      isReasoning: undefined,
    });
  });
});

describe("toLintErrorObject", () => {
  it("passes an Error straight through", () => {
    const err = new Error("boom");
    expect(toLintErrorObject(err, "fallback")).toBe(err);
  });

  it("wraps a string as its own message, ignoring the fallback", () => {
    expect(toLintErrorObject("boom", "fallback").message).toBe("boom");
  });

  it("uses the fallback message for a non-Error object and keeps it as the cause", () => {
    const thrown = { status: 500 };
    const error = toLintErrorObject(thrown, "Prompt failed");
    expect(error.message).toBe("Prompt failed");
    expect(error.cause).toBe(thrown);
    // Own properties are copied onto the error so downstream status checks still work.
    expect((error as unknown as { status?: number }).status).toBe(500);
  });

  it("does not attempt to copy properties off a primitive or null", () => {
    expect(toLintErrorObject(null, "Prompt failed").message).toBe("Prompt failed");
    expect(toLintErrorObject(42, "Prompt failed").cause).toBe(42);
  });
});
