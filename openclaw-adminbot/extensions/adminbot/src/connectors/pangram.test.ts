import { describe, expect, it, vi } from "vitest";
import { createPangramScorer, PANGRAM_MODEL, PangramError } from "./pangram.js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Pangram scorer", () => {
  it("scores with Pangram 4, polls to success and returns the fractions and version", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: "task-1" }))
      .mockResolvedValueOnce(json({ stage: "STAGE_PREPROCESSING" }))
      .mockResolvedValueOnce(
        json({
          stage: "STAGE_SUCCESS",
          version: "4.0",
          prediction_short: "AI",
          fraction_ai: 0.82,
          fraction_ai_assisted: 0,
          fraction_human: 0.18,
          text: "echoed manuscript text",
        }),
      );
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl, pollIntervalMs: 0 });

    await expect(score("Some text.", AbortSignal.timeout(5_000))).resolves.toEqual({
      fraction_ai: 0.82,
      fraction_ai_assisted: 0,
      fraction_human: 0.18,
      prediction: "AI",
      model_version: "4.0",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://text.external-api.pangram.com/task");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "x-api-key": "key-1" });
    // The model is pinned: the API's default is Pangram 3.3.2, which scored a paper the website
    // put at 82% as 0%. Never a shareable dashboard page of a restricted manuscript.
    expect(PANGRAM_MODEL).toBe("pangram-4");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Some text.",
      model: "pangram-4",
      public_dashboard_link: false,
    });
    expect(fetchImpl.mock.calls[2][0]).toBe("https://text.external-api.pangram.com/task/task-1");
  });

  it("reports an exhausted account as a fixed message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ detail: "x" }, 402));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl, pollIntervalMs: 0 });

    await expect(score("Some text.", AbortSignal.timeout(5_000))).rejects.toEqual(
      new PangramError("The Pangram account is out of credits."),
    );
  });

  it("fails a task Pangram could not classify", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: "task-1" }))
      .mockResolvedValueOnce(json({ stage: "STAGE_FAILED" }));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl, pollIntervalMs: 0 });

    await expect(score("Some text.", AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(
      PangramError,
    );
  });

  it("gives up on a task that never finishes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/task")
        ? json({ task_id: "task-1" })
        : json({ stage: "STAGE_RUNNING" }),
    );
    const score = createPangramScorer({
      apiKey: "key-1",
      fetchImpl,
      pollIntervalMs: 1,
      maxWaitMs: 5,
    });

    await expect(score("Some text.", AbortSignal.timeout(5_000))).rejects.toEqual(
      new PangramError("Pangram did not finish in time."),
    );
  });

  it("refuses a result without an AI fraction rather than reading it as human", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: "task-1" }))
      .mockResolvedValueOnce(json({ stage: "STAGE_SUCCESS" }));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl, pollIntervalMs: 0 });

    await expect(score("Some text.", AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(
      PangramError,
    );
  });

  it("drops a version string that is not a version", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: "task-1" }))
      .mockResolvedValueOnce(
        json({ stage: "STAGE_SUCCESS", version: "<script>", fraction_ai: 0.1 }),
      );
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl, pollIntervalMs: 0 });

    const result = await score("Some text.", AbortSignal.timeout(5_000));
    expect(result.model_version).toBeUndefined();
  });
});
