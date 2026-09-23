import { describe, expect, it, vi } from "vitest";
import {
  createGptZeroBibliographyScanner,
  createPublicOpenReviewPdfReader,
  GptZeroScanError,
  parseGptZeroBibliography,
} from "./reference-scan.js";

const reply = (statuses: Array<string | null>) => [
  {
    id: "synthetic-scan",
    version: 1,
    bibliographic_citations: statuses.map((status) => ({
      text: "Synthetic citation",
      citation_exists: status === null ? null : { status, justification: "Synthetic explanation" },
    })),
  },
];

describe("GPTZero bibliography connector", () => {
  it("distinguishes findings, uncertainty, and confirmed existence", () => {
    const result = parseGptZeroBibliography(
      reply(["exist", "fake", "exist_with_issues", "unsure", "unknown", null]),
    );
    expect(result.citation_count).toBe(6);
    expect(result.uncertain_count).toBe(3);
    expect(result.findings.map((finding) => finding.status)).toEqual(["fake", "exist_with_issues"]);
  });
  it.each([{}, [], [{ id: "scan", version: 1 }], reply(["new-provider-status"])])(
    "rejects malformed or incompatible responses",
    (response) => {
      expect(() => parseGptZeroBibliography(response)).toThrow();
    },
  );
  it("posts the documented multipart request and keeps the key in a header", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reply(["exist"])));
    const scan = createGptZeroBibliographyScanner(
      { GPTZERO_API_KEY: "synthetic-secret" },
      fetchImpl,
    )!;
    await scan(Buffer.from("%PDF-synthetic"));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.gptzero.me/v2/bibliography-scan/files",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { "x-api-key": "synthetic-secret", Accept: "application/json" },
      }),
    );
    const form = fetchImpl.mock.calls[0][1]!.body as FormData;
    expect(await (form.get("files") as Blob).text()).toBe("%PDF-synthetic");
  });
  it("fails closed without credentials or on provider errors", async () => {
    expect(createGptZeroBibliographyScanner({})).toBeUndefined();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret-provider-detail", { status: 429 }));
    await expect(
      createGptZeroBibliographyScanner({ GPTZERO_API_KEY: "test" }, fetchImpl)!(new Uint8Array()),
    ).rejects.toThrow("HTTP 429");
  });
  it.each([401, 403, 422, 429, 500])(
    "exposes only HTTP %s, never the provider body",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private manuscript and key", { status }));
      const scan = createGptZeroBibliographyScanner({ GPTZERO_API_KEY: "test" }, fetchImpl)!;
      await expect(scan(new Uint8Array())).rejects.toEqual(new GptZeroScanError(status));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("distinguishes connection failures from incompatible results without leaking details", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("private network details"))
      .mockResolvedValueOnce(new Response("private invalid JSON"))
      .mockResolvedValueOnce(Response.json({ private: "unexpected response" }));
    const scan = createGptZeroBibliographyScanner({ GPTZERO_API_KEY: "test" }, fetchImpl)!;
    await expect(scan(new Uint8Array())).rejects.toEqual(new GptZeroScanError("connection"));
    await expect(scan(new Uint8Array())).rejects.toEqual(new GptZeroScanError("response"));
    await expect(scan(new Uint8Array())).rejects.toEqual(new GptZeroScanError("response"));
  });
  it("identifies a timeout without retrying the scan", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw new Error("private timeout details");
    });
    try {
      const scan = createGptZeroBibliographyScanner({ GPTZERO_API_KEY: "test" }, fetchImpl)!;
      await expect(scan(new Uint8Array())).rejects.toEqual(new GptZeroScanError("timeout"));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("public OpenReview PDF reader", () => {
  it("downloads through fixed OpenReview endpoints without credentials", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          notes: [
            {
              id: "paper123",
              content: {
                title: { value: "Synthetic paper" },
                pdf: { value: "https://untrusted.example/private" },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("%PDF-synthetic"));
    const pdf = await createPublicOpenReviewPdfReader(fetchImpl)("paper123");
    expect(pdf.title).toBe("Synthetic paper");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://api2.openreview.net/notes?id=paper123",
      "https://api2.openreview.net/pdf?id=paper123",
    ]);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options?.headers).toBeUndefined();
      expect(options?.redirect).toBe("error");
    }
  });
  it("rejects arbitrary URLs before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      createPublicOpenReviewPdfReader(fetchImpl)("http://localhost/private"),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses private or unavailable submissions", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ notes: [] }));
    await expect(createPublicOpenReviewPdfReader(fetchImpl)("paper123")).rejects.toThrow(
      "not publicly readable",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
