// Reading arXiv's answer, including the one shape that means "no such paper".
import { describe, expect, it } from "vitest";
import { createArxivProbe, readArxivEntry } from "./arxiv.js";

const feed = (entry: string) => `<?xml version="1.0"?><feed>${entry}</feed>`;

describe("readArxivEntry", () => {
  it("reads the title off a real entry", () => {
    expect(
      readArxivEntry(
        feed(
          "<entry><id>http://arxiv.org/abs/2601.00001v1</id><title>Causal Garden\n  Planning</title></entry>",
        ),
      ),
    ).toEqual({ status: "found", title: "Causal Garden Planning" });
  });

  // arXiv does not 404 an unknown id: it answers with one entry whose title is literally "Error".
  it("reads arXiv's error entry as the paper not existing", () => {
    expect(
      readArxivEntry(
        feed("<entry><title>Error</title><summary>incorrect id format</summary></entry>"),
      ),
    ).toEqual({ status: "missing" });
  });

  it("treats a feed with no entry as not knowing, rather than as absence", () => {
    expect(readArxivEntry(feed(""))).toMatchObject({ status: "unreadable" });
  });
});

describe("createArxivProbe", () => {
  it("asks for the id it was given and reports what came back", async () => {
    const urls: string[] = [];
    const probe = createArxivProbe({
      baseUrl: "https://arxiv.example/query",
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          text: async () => feed("<entry><title>Causal Garden Planning</title></entry>"),
        };
      }) as never,
    });

    await expect(probe("2601.00001")).resolves.toEqual({
      status: "found",
      title: "Causal Garden Planning",
    });
    expect(urls[0]).toBe("https://arxiv.example/query?id_list=2601.00001&max_results=1");
  });

  it("reads an arXiv that is down as not knowing", async () => {
    const down = createArxivProbe({
      fetchImpl: (async () => ({ ok: false, status: 503, text: async () => "" })) as never,
    });
    await expect(down("2601.00001")).resolves.toMatchObject({ status: "unreadable" });

    const offline = createArxivProbe({
      fetchImpl: (async () => {
        throw new Error("network unreachable");
      }) as never,
    });
    await expect(offline("2601.00001")).resolves.toMatchObject({ status: "unreadable" });
  });

  // Checked here as well as by the caller: this is the last point before it becomes a query string.
  it("refuses an id that is not one without asking", async () => {
    let asked = false;
    const probe = createArxivProbe({
      fetchImpl: (async () => {
        asked = true;
        return { ok: true, status: 200, text: async () => "" };
      }) as never,
    });

    await expect(probe("../../etc/passwd")).resolves.toEqual({
      status: "unreadable",
      reason: "not an arXiv id",
    });
    expect(asked).toBe(false);
  });
});
