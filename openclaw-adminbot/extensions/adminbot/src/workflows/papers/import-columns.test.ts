import { describe, expect, it } from "vitest";
import { createImportColumnMapper, readMapping } from "./import-columns.js";

const asked = [
  { header: "The latex one", samples: ["https://www.overleaf.com/project/abc"] },
  { header: "pw", samples: ["ab12cd"] },
];
const available = ["overleaf_edit_url", "arxiv_paper_password", "poster_url"];

describe("reading the model's answer", () => {
  it("keeps a mapping that names a column it was asked about and a field it was offered", () => {
    const text = '{"mapping":{"The latex one":"overleaf_edit_url","pw":"arxiv_paper_password"}}';
    expect(readMapping(text, asked, available)).toEqual({
      "The latex one": "overleaf_edit_url",
      pw: "arxiv_paper_password",
    });
  });

  it("reads through the fence models add even when told not to", () => {
    const text = 'Sure!\n```json\n{"mapping":{"pw":"arxiv_paper_password"}}\n```';
    expect(readMapping(text, asked, available)).toEqual({ pw: "arxiv_paper_password" });
  });

  // The narrow gate: the answer becomes a write, so nothing unasked-for gets through.
  it("drops a header nobody asked about and a field that was not offered", () => {
    const text =
      '{"mapping":{"Some other column":"poster_url","pw":"venue_decision","The latex one":"nope"}}';
    expect(readMapping(text, asked, available)).toEqual({});
  });

  it("gives one field to one column when the model names it twice", () => {
    const text = '{"mapping":{"The latex one":"poster_url","pw":"poster_url"}}';
    expect(readMapping(text, asked, available)).toEqual({ "The latex one": "poster_url" });
  });

  it("returns nothing for a reply that is not JSON", () => {
    expect(readMapping("I could not tell", asked, available)).toEqual({});
    expect(readMapping('{"mapping":[]}', asked, available)).toEqual({});
  });
});

describe("the mapper", () => {
  it("asks nothing when there is nothing to ask about", async () => {
    let called = false;
    const mapper = createImportColumnMapper({
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as never,
    });
    expect(await mapper({ unmapped: [], available })).toEqual({});
    expect(await mapper({ unmapped: asked, available: [] })).toEqual({});
    expect(called).toBe(false);
  });

  // The local pass has already produced a usable mapping, so a dead tunnel costs the leftovers
  // and nothing else.
  it("fails soft when the tunnel is down", async () => {
    const mapper = createImportColumnMapper({
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as never,
    });
    expect(await mapper({ unmapped: asked, available })).toEqual({});
  });
});
