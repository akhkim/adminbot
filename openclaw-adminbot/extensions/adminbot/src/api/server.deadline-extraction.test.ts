import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createLocalChat } from "../privacy/local-chat.js";
import { extractDeadlineSchedule } from "./server.deadline-extraction.js";
const body = {
  context: { scope: "Example 2035" },
  documents: { "https://example.org": "Submission September 25, 2035" },
};
beforeEach(() => vi.stubEnv("ADMINBOT_LOCAL_MODEL", "test-local"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function model(content: string, finish_reason = "stop", responseModel = "test-local") {
  return vi.fn(async (_url: string, _init?: { signal?: AbortSignal }) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () =>
      JSON.stringify({ model: responseModel, choices: [{ finish_reason, message: { content } }] }),
  }));
}
describe("shared local schedule extraction", () => {
  it("uses shared configuration, structured output and the caller's cancellation signal", async () => {
    vi.stubEnv("ADMINBOT_LOCAL_BASE_URL", "http://127.0.0.1:8000/v1");
    const fetcher = model('{"entries":[],"issues":[]}');
    const signal = new AbortController().signal;
    expect(await extractDeadlineSchedule(body, signal, fetcher)).toEqual({
      entries: [],
      issues: [],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/v1/chat/completions",
      expect.objectContaining({ signal: expect.any(AbortSignal), redirect: "error" }),
    );
  });
  it("yields an in-flight extraction to chat and resumes after idle time", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let extractionSignal: AbortSignal | undefined;
    const fetcher = model('{"entries":[],"issues":[]}');
    fetcher.mockImplementationOnce(async (_url, init) => {
      extractionSignal = init?.signal;
      started();
      return await new Promise((_, reject) => {
        extractionSignal!.addEventListener("abort", () => reject(extractionSignal!.reason), {
          once: true,
        });
      });
    });
    const extraction = extractDeadlineSchedule(body, caller.signal, fetcher);
    await vi.advanceTimersByTimeAsync(2100);
    await ready;
    const chat = createLocalChat({
      env: { ADMINBOT_LOCAL_MODEL: "test-local" },
      fetchImpl: model("Hello"),
    });
    expect(await chat.complete([{ role: "user", content: "Hello" }])).toBe("Hello");
    expect(extractionSignal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2100);
    expect(await extraction).toEqual({ entries: [], issues: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["https://example.com/v1", "http://user@localhost/v1", "ftp://localhost/v1"])(
    "rejects unsafe model endpoint %s",
    async (url) => {
      vi.stubEnv("ADMINBOT_LOCAL_BASE_URL", url);
      const fetcher = model("{}");
      await expect(
        extractDeadlineSchedule(body, new AbortController().signal, fetcher),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects truncated output and malformed schedules", async () => {
    await expect(
      extractDeadlineSchedule(
        body,
        new AbortController().signal,
        model('{"entries":[],"issues":[]}', "length"),
      ),
    ).rejects.toThrow("incomplete");
    await expect(
      extractDeadlineSchedule(body, new AbortController().signal, model("{}")),
    ).rejects.toThrow("Invalid extracted");
  });
  it.each(["other-model", ""])(
    "rejects a model response identified as %s",
    async (responseModel) => {
      await expect(
        extractDeadlineSchedule(
          body,
          new AbortController().signal,
          model('{"entries":[],"issues":[]}', "stop", responseModel),
        ),
      ).rejects.toThrow("did not match");
    },
  );
  it("rejects oversized documents before inference", async () => {
    const fetcher = model("{}");
    await expect(
      extractDeadlineSchedule(
        { ...body, documents: { "https://example.org": "a".repeat(80001) } },
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toThrow("limits");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
