import { afterEach, expect, it, vi } from "vitest";
import { LabSharingStatus } from "./lab-sharing-status.ts";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("expires visible status without refresh and clears on logout", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: {
          availability: "busy",
          message: "Synthetic status",
          updated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 1000).toISOString(),
        },
      }),
    }),
  );
  const el = document.createElement("lab-sharing-status") as LabSharingStatus;
  el.sessionToken = "test";
  document.body.append(el);
  await el.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.textContent).toContain("Synthetic status");
  await vi.advanceTimersByTimeAsync(1000);
  await el.updateComplete;
  expect(el.textContent).not.toContain("Synthetic status");
  expect(el.textContent).toContain("No current status shared");
  el.sessionToken = "";
  await el.updateComplete;
  expect(el.textContent?.trim()).toBe("");
});

it("preserves an admin draft after a failed publish and hides editor for members", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ status: null, can_manage: true }) })
    .mockRejectedValueOnce(new Error("Offline"));
  vi.stubGlobal("fetch", fetcher);
  const el = document.createElement("lab-sharing-status") as LabSharingStatus;
  el.sessionToken = "admin";
  document.body.append(el);
  await el.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  const message = el.querySelector("textarea")!;
  message.value = "Reviewing synthetic papers";
  message.dispatchEvent(new Event("input"));
  const expiry = el.querySelector("input")!;
  expiry.value = "2099-01-01T12:00";
  expiry.dispatchEvent(new Event("input"));
  await el.updateComplete;
  el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(fetcher.mock.calls[1][1].method).toBe("PUT");
  expect(el.querySelector("textarea")!.value).toBe(message.value);
  expect(el.textContent).toContain("Offline");
  fetcher.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ status: null, can_manage: false }),
  });
  el.sessionToken = "member";
  await el.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.querySelector("form")).toBeNull();
});
