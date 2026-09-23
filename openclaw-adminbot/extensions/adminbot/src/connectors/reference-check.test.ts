import { describe, expect, it, vi } from "vitest";
import { lookupContext, referenceFetch } from "./reference-check.http.js";
import { createPdfReferenceChecker, extractPdfReferences } from "./reference-check.js";
import { referencePdf } from "./reference-check.test-helpers.js";

const citation =
  "Lovelace, A. (2024). Testing synthetic reference matching. Journal of Tests. https://doi.org/10.1234/synthetic";
const record = {
  title: ["Testing synthetic reference matching"],
  author: [{ family: "Lovelace", given: "Ada" }],
  published: { "date-parts": [[2024]] },
  "container-title": ["Journal of Tests"],
  DOI: "10.1234/synthetic",
  URL: "https://doi.org/10.1234/synthetic",
  type: "journal-article",
};
const signal = () => new AbortController().signal;
const emptyDatabase = (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "export.arxiv.org") {
    return new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>');
  }
  const value =
    url.hostname === "api.crossref.org"
      ? { message: { items: [] } }
      : url.hostname === "api.openalex.org"
        ? { results: [] }
        : url.hostname === "dblp.org"
          ? { result: { hits: { "@total": "0" } } }
          : { data: [] };
  return Response.json(value);
};

describe("References-Validation integration", () => {
  it("extracts a real PDF bibliography and excludes manuscript text and appendix", async () => {
    const pdf = referencePdf([
      "Private manuscript text",
      "References",
      `[1] ${citation}`,
      "[2] Doe, J. (2023). A second synthetic reference.",
      "Appendix A: Supplementary details",
      "Private appendix",
    ]);
    const refs = await extractPdfReferences(pdf);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toContain("Testing synthetic reference matching");
    expect(refs.join(" ")).not.toContain("Private");
  });

  it("separates conference-style year-ending references and stops at lettered appendices", async () => {
    const refs = await extractPdfReferences(
      referencePdf([
        "References",
        "Ada Lovelace and Alan Turing. A synthetic reference title.",
        "Journal of Synthetic Work,",
        "2024.",
        "Grace Hopper and Jane Smith. Another synthetic title. Proceedings of Tests,",
        "2023.",
        "A APPENDIX",
        "Private appendix body.",
      ]),
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toContain("Ada Lovelace");
    expect(refs[1]).toContain("Grace Hopper");
    expect(refs.join(" ")).not.toContain("Private");
  });

  it("rejects unreadable PDFs and absent bibliographies without querying databases", async () => {
    const fetcher = vi.fn();
    const check = createPdfReferenceChecker({ fetch: fetcher });
    await expect(check(Buffer.from("%PDF-invalid"), signal())).rejects.toThrow("could not be read");
    await expect(check(referencePdf(["Only manuscript content"]), signal())).rejects.toThrow(
      "No References",
    );
    await expect(check(referencePdf(["References"]), signal())).rejects.toThrow(
      "No references could be extracted",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks a real PDF with the upstream engine and repeats checks without caching", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ message: record }),
    );
    const check = createPdfReferenceChecker({ fetch: fetcher, requestIntervalMs: 0 });
    const pdf = referencePdf(["References", citation]);
    for (let i = 0; i < 2; i++) {
      const report = await check(pdf, signal());
      expect(report.findings[0]).toMatchObject({
        status: "matched",
        source: "CrossRef",
        title: record.title[0],
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[0][0] as URL).href).toContain("api.crossref.org/works/10.1234");
  });

  it("reports not found using available databases despite other source failures", async () => {
    const extract = async () => [
      "Doe, J. (2024). An entirely invented synthetic research title. Test Journal.",
    ];
    const empty = createPdfReferenceChecker({
      extract,
      fetch: vi.fn(async (input) => emptyDatabase(input)),
      requestIntervalMs: 0,
    });
    expect((await empty(new Uint8Array(), signal())).findings[0].status).toBe("not_found");
    for (const response of [
      () => new Response("rate limited", { status: 429 }),
      () => new Response("not JSON"),
      () => Response.json({}),
    ]) {
      const fetcher = vi.fn(async (input) =>
        String(input).includes("api.crossref.org") ? response() : emptyDatabase(input),
      );
      const check = createPdfReferenceChecker({ extract, fetch: fetcher, requestIntervalMs: 0 });
      const finding = (await check(new Uint8Array(), signal())).findings[0];
      expect(finding.status).toBe("not_found");
      expect(finding.explanation).toBe("No matching reference found in the available databases.");
    }
  });

  it("reports a total outage without claiming references were searched successfully", async () => {
    const check = createPdfReferenceChecker({
      extract: async () => [citation],
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
      requestIntervalMs: 0,
    });
    const finding = (await check(new Uint8Array(), signal())).findings[0];
    expect(finding.status).toBe("unavailable");
    expect(finding.explanation).toContain("No reference databases could be reached");
    expect(finding.explanation).not.toContain("incomplete");
  });

  it("emits each result before checking the next citation", async () => {
    const progress = vi.fn();
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 2) {
        expect(progress).toHaveBeenLastCalledWith(
          expect.objectContaining({
            completed: 1,
            total: 2,
            finding: expect.objectContaining({ status: "matched" }),
          }),
        );
      }
      return Response.json({ message: record });
    });
    const check = createPdfReferenceChecker({
      extract: async () => [citation, citation],
      fetch: fetcher,
      requestIntervalMs: 0,
    });
    await check(new Uint8Array(), signal(), progress);
    expect(progress.mock.calls.map(([event]) => event.completed)).toEqual([0, 1, 2]);
  });

  it("marks retracted works for review", async () => {
    const check = createPdfReferenceChecker({
      extract: async () => [citation],
      fetch: vi.fn(async () =>
        Response.json({ message: { ...record, "update-to": [{ type: "retraction" }] } }),
      ),
    });
    const report = await check(new Uint8Array(), signal());
    expect(report.findings[0].status).toBe("review");
    expect(report.findings[0].explanation).toContain("retracted");
  });

  it("aborts before lookups and restricts network access to database hosts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    const check = createPdfReferenceChecker({ extract: async () => [citation], fetch: fetcher });
    await expect(check(new Uint8Array(), controller.signal)).rejects.toThrow();
    await lookupContext.run(
      { signal: signal(), failures: new Set(), lastRequest: new Map(), fetch: fetcher },
      async () => {
        await expect(referenceFetch("https://127.0.0.1/private")).rejects.toThrow("Unsupported");
        await expect(referenceFetch("http://api.crossref.org/works")).rejects.toThrow(
          "Unsupported",
        );
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
