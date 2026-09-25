import { describe, expect, it, vi } from "vitest";
import { createPangramScorer, PangramError } from "./pangram.js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const pdf = new Uint8Array(Buffer.from("%PDF-1.6 synthetic manuscript"));

// The shape Pangram's file endpoint returned for a real 39-page submission: one result per file,
// with its own extraction of the text.
const result = {
  filename: "submission.pdf",
  prediction_short: "Mixed",
  fraction_ai: 0.105,
  fraction_ai_assisted: 0.013,
  fraction_human: 0.882,
  text: "one two three four five",
  windows: [],
};

describe("Pangram scorer", () => {
  it("uploads the whole PDF and returns the fractions and the words Pangram scored", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json([result]));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl });

    await expect(score(pdf, AbortSignal.timeout(5_000))).resolves.toEqual({
      fraction_ai: 0.105,
      fraction_ai_assisted: 0.013,
      fraction_human: 0.882,
      prediction: "Mixed",
      words_scored: 5,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://file-external.api.pangram.com/");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "x-api-key": "key-1" });
    const form = init?.body as FormData;
    const file = form.get("files") as File;
    // A fixed name: the paper's title is not something to hand a third party with the file.
    expect(file.name).toBe("submission.pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);
    // Never a shareable dashboard page of a restricted manuscript.
    expect(form.get("public_dashboard_link")).toBe("false");
  });

  it("reads a result wrapped in an object as well as a bare list", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ results: [result] }));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl });

    await expect(score(pdf, AbortSignal.timeout(5_000))).resolves.toMatchObject({
      fraction_ai: 0.105,
    });
  });

  it("reports an exhausted account as a fixed message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ detail: "x" }, 402));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl });

    await expect(score(pdf, AbortSignal.timeout(5_000))).rejects.toEqual(
      new PangramError("The Pangram account is out of credits."),
    );
  });

  it("reports a file Pangram will not take as a fixed message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ detail: "x" }, 413));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl });

    await expect(score(pdf, AbortSignal.timeout(5_000))).rejects.toEqual(
      new PangramError("The PDF is larger than Pangram accepts."),
    );
  });

  it("refuses a result without an AI fraction rather than reading it as human", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ ...result, fraction_ai: undefined }]));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl });

    await expect(score(pdf, AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(PangramError);
  });

  it("refuses an empty or unreadable response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json([]));
    const score = createPangramScorer({ apiKey: "key-1", fetchImpl });

    await expect(score(pdf, AbortSignal.timeout(5_000))).rejects.toEqual(
      new PangramError("Pangram returned an unreadable response."),
    );
  });
});
