import { afterEach, expect, it, vi } from "vitest";
import type { LabSharingInvites } from "./lab-sharing-invites.ts";
import "./lab-sharing-invites.ts";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("creates a pending request, retains drafts on failure and clears on logout", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    json: async () =>
      url.endsWith("/lab-sharing")
        ? { projects: [{ id: "project", title: "Synthetic project" }] }
        : init?.method === "POST"
          ? { id: "proposal", status: "pending" }
          : { invites: [] },
  }));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("scrollIntoView", vi.fn());
  const el = document.createElement("lab-sharing-invites") as LabSharingInvites;
  el.scrollIntoView = vi.fn();
  el.sessionToken = "member";
  document.body.append(el);
  await el.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  await el.selectMember("recipient", "Ravi Reader");
  const project = el.querySelector("select")!;
  project.value = "project";
  project.dispatchEvent(new Event("change"));
  const note = el.querySelector("textarea")!;
  note.value = "Review synthetic traces";
  note.dispatchEvent(new Event("input"));
  await el.updateComplete;
  el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.textContent).toContain("Invitation request: Pending administrator approval");
  const sent = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(sent[1]?.body))).toEqual({
    paper_id: "project",
    recipient_id: "recipient",
    kind: "collaboration",
    note: "Review synthetic traces",
  });
  fetcher.mockRejectedValueOnce(new Error("Offline"));
  el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.textContent).toContain("Offline");
  expect(el.querySelector("textarea")!.value).toBe("Review synthetic traces");
  await el.selectMember("another", "Mina Member");
  await el.updateComplete;
  expect(el.querySelector("textarea")!.value).toBe("");
  expect(el.textContent).not.toContain("Offline");
  expect(el.textContent).not.toContain("Invitation request:");
  el.sessionToken = "";
  await el.updateComplete;
  expect(el.textContent?.trim()).toBe("");
});

it("keeps submission success distinct from a failed history refresh", async () => {
  vi.useFakeTimers();
  let accepted = false;
  let finish: (() => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      await new Promise<void>((resolve) => { finish = resolve; });
      accepted = true;
      return { ok: true, json: async () => ({ status: "pending" }) };
    }
    if (accepted) throw new Error("Offline");
    return { ok: true, json: async () => url.endsWith("/lab-sharing")
      ? { projects: [{ id: "project", title: "Synthetic project" }] }
      : { invites: [] } };
  }));
  const el = document.createElement("lab-sharing-invites") as LabSharingInvites;
  el.scrollIntoView = vi.fn();
  el.sessionToken = "member";
  document.body.append(el);
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  await el.selectMember("recipient", "Ravi Reader");
  el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await el.selectMember("another", "Mina Member");
  expect(el.textContent).toContain("Ravi Reader");
  finish!();
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.textContent).toContain("Invitation request: Pending administrator approval");
  expect(el.textContent).toContain("Your request was accepted, but history could not refresh");
});
