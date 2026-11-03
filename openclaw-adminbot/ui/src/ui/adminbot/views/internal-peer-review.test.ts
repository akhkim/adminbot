/* @vitest-environment jsdom */
import { afterEach, it, expect, vi } from "vitest";
const session = vi.hoisted(() => ({ token: "synthetic-session" }));
vi.mock("../auth/session.ts", async (original) => ({
  ...(await original<typeof import("../auth/session.ts")>()),
  loadStoredMemberSession: () => ({ sessionToken: session.token }),
  resolveAdminBotBaseUrl: () => "http://127.0.0.1:8765",
}));
import { InternalPeerReview } from "./internal-peer-review.ts";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  session.token = "synthetic-session";
});
async function mount() {
  const element = new InternalPeerReview();
  element.paperId = "paper";
  element.sessionToken = session.token;
  document.body.append(element);
  await element.updateComplete;
  return element;
}
it("loads private nominations, adds a suggested ID and saves without an invite", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        draft: null,
        suggestions: [{ member_id: "reader", name: "Reader", matched_topics: ["causal"] }],
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        draft: { revision: 1, data: { purpose: "", draft_url: "", nominee_ids: ["reader"] } },
        detail: "No invitation sent.",
      }),
    });
  vi.stubGlobal("fetch", fetch);
  const element = await mount();
  (element.querySelector("button") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(element.textContent).toContain("Reader"));
  const buttons = () => [...element.querySelectorAll("button")];
  buttons()
    .find((b) => b.textContent?.trim() === "Nominate")!
    .click();
  await element.updateComplete;
  buttons()
    .find((b) => b.textContent?.trim() === "Save private draft")!
    .click();
  await vi.waitFor(() => expect(element.textContent).toContain("No invitation sent."));
  expect(JSON.parse(fetch.mock.calls[1][1].body).data.nominee_ids).toEqual(["reader"]);
  expect(fetch.mock.calls[1][1].method).toBe("PUT");
});
it("clears private content when the session changes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        draft: { revision: 2, data: { purpose: "Private", draft_url: "", nominee_ids: [] } },
        suggestions: [],
      }),
    }),
  );
  const element = await mount();
  (element.querySelector("button") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(element.querySelector("textarea")?.value).toBe("Private"));
  session.token = "changed";
  element.sessionToken = "changed";
  await element.updateComplete;
  expect(element.querySelector("textarea")).toBeNull();
});
