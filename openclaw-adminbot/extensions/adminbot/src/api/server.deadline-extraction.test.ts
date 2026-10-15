import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { extractDeadlineSchedule } from "./server.deadline-extraction.js";
const body = {
  context: { scope: "Example 2035" },
  documents: { "https://example.org": "Submission September 25, 2035" },
};
beforeEach(() => {
  vi.stubEnv("ADMINBOT_LOCAL_MODEL", "test-local");
  // A host that runs the shared gateway must not reroute the direct-endpoint cases.
  vi.stubEnv("LLM_GATEWAY_URL", "");
});
afterEach(() => vi.unstubAllEnvs());
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
  it("queues through the shared LLM gateway's local route when one is configured", async () => {
    vi.stubEnv("ADMINBOT_LOCAL_BASE_URL", "http://127.0.0.1:8000/v1");
    vi.stubEnv("LLM_GATEWAY_URL", "http://127.0.0.1:8766");
    vi.stubEnv("LLM_GATEWAY_TOKEN", "gateway-token");
    const fetcher = model('{"entries":[],"issues":[]}');
    const caller = new AbortController();
    expect(await extractDeadlineSchedule(body, caller.signal, fetcher)).toEqual({
      entries: [],
      issues: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetcher.mock.calls[0]!;
    expect(endpoint).toBe("http://127.0.0.1:8766/local/v1/chat/completions");
    // The caller's own signal reaches the gateway unchanged: disconnecting is what dequeues it.
    expect(init?.signal).toBe(caller.signal);
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
