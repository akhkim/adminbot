import { afterEach, expect, it, vi } from "vitest";
import { LabSharingMemberSearch } from "./lab-sharing-member-search.ts";
const result = (name: string) => ({
  ok: true,
  json: async () => ({
    members: [
      {
        id: name,
        name,
        research_branch: "NLP",
        research_topics: [],
        matched_fields: ["name"],
        projects: [],
      },
    ],
    truncated: false,
  }),
});
async function type(el: LabSharingMemberSearch, query: string) {
  const input = el.querySelector("input")!;
  input.value = query;
  input.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(260);
  await el.updateComplete;
}
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("discards stale queries and clears member results on session change", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(result("New member")),
  );
  const el = new LabSharingMemberSearch();
  el.sessionToken = "old";
  document.body.append(el);
  await el.updateComplete;
  await type(el, "old");
  await type(el, "new");
  expect(el.textContent).toContain("New member");
  finish(result("Old member"));
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.textContent).not.toContain("Old member");
  el.sessionToken = "next";
  await el.updateComplete;
  expect(el.textContent).not.toContain("New member");
  expect(el.querySelector("input")!.value).toBe("");
});
it("retries failures and avoids fetching short queries", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(result("Recovered member"));
  vi.stubGlobal("fetch", fetcher);
  const el = new LabSharingMemberSearch();
  el.sessionToken = "synthetic";
  document.body.append(el);
  await el.updateComplete;
  await type(el, "a");
  expect(fetcher).not.toHaveBeenCalled();
  await type(el, "ada");
  expect(el.querySelector('[role="alert"]')?.textContent).toBe("Offline");
  el.querySelector("button")!.click();
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.textContent).toContain("Recovered member");
});
