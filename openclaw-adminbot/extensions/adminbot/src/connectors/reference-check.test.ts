import { describe, expect, it, vi } from "vitest";
import { cooldownFor, lookupContext, referenceFetch } from "./reference-check.http.js";
import {
  createPdfReferenceChecker,
  extractPdfReferences,
  NO_TEXT_LAYER,
  requiredDatabasesPausedUntil,
} from "./reference-check.js";
import { referencePdf, referencePdfPages } from "./reference-check.test-helpers.js";

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

  it("reads a bibliography that starts after page 20", async () => {
    // clawpdf stops at page 20 unless asked for more; long papers lost their references.
    const body = Array.from({ length: 22 }, (_, i) => [`Synthetic manuscript page ${i + 1}`]);
    const pdf = referencePdfPages([
      ...body,
      ["References", `[1] ${citation}`, "[2] Doe, J. (2023). A second synthetic reference."],
    ]);
    const refs = await extractPdfReferences(pdf);
    expect(refs).toHaveLength(2);
  });

  it.each([
    ["[1]", "[2]"],
    ["[1] ", "[2] "],
    ["(1)", "(2)"],
    ["(1) ", "(2) "],
    ["1. ", "2. "],
  ])("splits numbered references with markers %s and %s", async (first, second) => {
    const refs = await extractPdfReferences(
      referencePdf([
        "References",
        first + "Smith J. First synthetic study.",
        "2024.",
        second + "Doe J. Second synthetic study.",
        "2023.",
      ]),
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toContain("Smith J.");
    expect(refs[0]).toContain("2024.");
    expect(refs[0]).not.toContain("Doe J.");
    expect(refs[1]).toContain("Doe J.");
    expect(refs[1]).toContain("2023.");
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

  it("with requireAllDatabases, claims not found only when Crossref, OpenAlex and DBLP answered", async () => {
    const extract = async () => [
      "Doe, J. (2024). An entirely invented synthetic research title. Test Journal.",
    ];
    const statusWhen = async (throttled: string) => {
      const check = createPdfReferenceChecker({
        extract,
        requireAllDatabases: true,
        requestIntervalMs: 0,
        fetch: vi.fn(async (input) =>
          String(input).includes(throttled)
            ? new Response("rate limited", { status: 429 })
            : emptyDatabase(input),
        ),
      });
      return (await check(new Uint8Array(), signal())).findings[0];
    };
    // Semantic Scholar and OpenAlex throttle anonymous clients; that alone must not hide a miss.
    expect((await statusWhen("api.semanticscholar.org")).status).toBe("not_found");
    expect((await statusWhen("api.openalex.org")).status).toBe("not_found");
    const partial = await statusWhen("dblp.org");
    expect(partial.status).toBe("unavailable");
    expect(partial.explanation).toContain("not fully checked");
  });

  it("with allowOversized, checks clean entries and never looks up an unsplittable chunk", async () => {
    const chunk = `${citation} `.repeat(30);
    const fetcher = vi.fn(async (input) => emptyDatabase(input));
    const check = createPdfReferenceChecker({
      extract: async (_pdf, limits) => {
        expect(limits?.allowOversized).toBe(true);
        return [citation, chunk];
      },
      allowOversized: true,
      requestIntervalMs: 0,
      fetch: fetcher,
    });
    const [clean, oversized] = (await check(new Uint8Array(), signal())).findings;
    expect(clean.status).not.toBe("unavailable");
    expect(fetcher).toHaveBeenCalled();
    expect(oversized).toMatchObject({ status: "unavailable", oversized_chars: chunk.length });
    expect(oversized.citation.length).toBeLessThan(310);
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes("Testing%20synthetic%20reference%20matching%20Journal"),
      ),
    ).toBe(false);
  });

  it("backs off a host that answers 429 or refuses connections, sharing the state across checks", async () => {
    const cooldowns = new Map<string, number>();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("dblp.org")) {
        throw new TypeError("fetch failed");
      }
      if (url.includes("api.openalex.org")) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
      }
      return emptyDatabase(input);
    });
    const check = createPdfReferenceChecker({
      extract: async () => ["Doe, J. (2024). An entirely invented synthetic research title."],
      cooldowns,
      requestIntervalMs: 0,
      fetch: fetcher,
    });
    const before = Date.now();
    await check(new Uint8Array(), signal());
    expect(cooldowns.get("api.openalex.org")! - before).toBeGreaterThanOrEqual(119_000);
    expect(cooldowns.get("dblp.org")! - before).toBeGreaterThanOrEqual(14 * 60_000);
    expect(requiredDatabasesPausedUntil(cooldowns)).toBe(cooldowns.get("dblp.org"));
    const hostsCalled = (from: number) =>
      new Set(fetcher.mock.calls.slice(from).map(([url]) => new URL(String(url)).hostname));
    const calls = fetcher.mock.calls.length;
    await check(new Uint8Array(), signal());
    // Neither backed-off host is asked again; the others still are.
    expect(hostsCalled(calls).has("dblp.org")).toBe(false);
    expect(hostsCalled(calls).has("api.openalex.org")).toBe(false);
    expect(hostsCalled(calls).has("api.crossref.org")).toBe(true);
  });

  it("bounds Retry-After and reads HTTP dates", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(cooldownFor(null, now)).toBe(15 * 60_000);
    expect(cooldownFor("5", now)).toBe(60_000);
    expect(cooldownFor("999999", now)).toBe(6 * 60 * 60_000);
    expect(cooldownFor("Wed, 23 Sep 2026 12:30:00 GMT", now)).toBe(30 * 60_000);
  });

  it("says a text-less PDF is a placeholder or scan, not a missing bibliography", async () => {
    await expect(extractPdfReferences(referencePdf([" "]))).rejects.toThrow(NO_TEXT_LAYER);
  });

  it("sends the OpenAlex key only to OpenAlex", async () => {
    const fetcher = vi.fn(async (input) => emptyDatabase(input));
    const check = createPdfReferenceChecker({
      extract: async () => ["Doe, J. (2024). An entirely invented synthetic research title."],
      openAlexApiKey: "synthetic-key",
      requestIntervalMs: 0,
      fetch: fetcher,
    });
    await check(new Uint8Array(), signal());
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes("api.openalex.org"))).not.toHaveLength(0);
    for (const url of urls) {
      expect(url.includes("api_key=synthetic-key")).toBe(url.includes("api.openalex.org"));
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
