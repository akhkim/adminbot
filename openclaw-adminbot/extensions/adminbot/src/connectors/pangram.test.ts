import { describe, expect, it, vi } from "vitest";
import { createPangramScorer, PangramError } from "./pangram.js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Pangram scorer", () => {
  it("creates a task, polls it to success and returns the fractions", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: "task-1" }))
      .mockResolvedValueOnce(json({ stage: "STAGE_PREPROCESSING" }))
      .mockResolvedValueOnce(
        json({
          stage: "STAGE_SUCCESS",
          prediction_short: "AI",
          fraction_ai: 0.64,
          fraction_ai_assisted: 0.2,
          fraction_human: 0.16,
          text: "echoed manuscript text",
        }),
      );
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl, pollIntervalMs: 0 });

    await expect(score("Some text.", AbortSignal.timeout(5_000))).resolves.toEqual({
      fraction_ai: 0.64,
      fraction_ai_assisted: 0.2,
      fraction_human: 0.16,
      prediction: "AI",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://text.external-api.pangram.com/task");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "x-api-key": "key-1" });
    // Never a shareable dashboard page of a restricted manuscript.
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Some text.",
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
});
