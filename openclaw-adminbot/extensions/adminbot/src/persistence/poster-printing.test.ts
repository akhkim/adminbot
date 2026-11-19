import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createPosterPrintStore } from "./poster-printing.js";

describe.each([
  ["memory", () => createPosterPrintStore()],
  ["sqlite", () => createPosterPrintStore(new DatabaseSync(":memory:"))],
])("poster print store (%s)", (_name, make) => {
  it("keeps one settings row per key and one answer per paper per conference", () => {
    const store = make();
    store.saveBatch({ conference_key: "default", lead_days: 14, updated_at: "a" });
    store.saveBatch({ conference_key: "default", lead_days: 10, updated_at: "b" });
    store.saveBatch({ conference_key: "neuripsparis:2026", printer_member_id: "rahul", updated_at: "c" });
    expect(store.listBatches().map((row) => [row.conference_key, row.lead_days])).toEqual([
      ["default", 10],
      ["neuripsparis:2026", undefined],
    ]);

    store.saveRequest({ conference_key: "neurips:2026", paper_id: "p", choice: "lab_print", updated_at: "a" });
    store.saveRequest({ conference_key: "neurips:2026", paper_id: "p", choice: "no_poster", updated_at: "b" });
    store.saveRequest({ conference_key: "iclr:2027", paper_id: "p", choice: "self_print", updated_at: "c" });
    expect(
      store
        .listRequests()
        .map((row) => `${row.conference_key}/${row.choice}`)
        .toSorted(),
    ).toEqual(["iclr:2027/self_print", "neurips:2026/no_poster"]);
  });
});
