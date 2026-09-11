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
        can_manage: true,
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
  expect(el.querySelector("select")!.value).toBe("busy");
  await vi.advanceTimersByTimeAsync(1000);
  await el.updateComplete;
  expect(el.textContent).not.toContain("Synthetic status");
  expect(el.textContent).toContain("No current update shared");
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

it("removes the editor after server authorization is revoked", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: null, can_manage: true }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: "Access revoked" } }),
      }),
  );
  const el = document.createElement("lab-sharing-status") as LabSharingStatus;
  el.sessionToken = "admin";
  document.body.append(el);
  await el.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.querySelector("form")).not.toBeNull();
  el.querySelector("button")!.click();
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.querySelector("form")).toBeNull();
  expect(el.textContent).toContain("Access revoked");
});


// The archive is the half a single-row table could never hold: what the lab was told before this
// week. Shown under the live broadcast, and never repeating it.
it("lists earlier updates under the current one, without repeating it", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
  const current = {
    id: "bcast_2",
    availability: "away",
    message: "Travelling this week",
    updated_at: "2026-09-10T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const older = {
    id: "bcast_1",
    availability: "busy",
    message: "Reviewing load is heavy",
    updated_at: "2026-08-28T00:00:00Z",
    expires_at: "2026-09-01T00:00:00Z",
  };
  const withdrawn = {
    id: "bcast_0",
    availability: "away",
    message: "Cancelled plan",
    updated_at: "2026-08-01T00:00:00Z",
    expires_at: "2026-08-10T00:00:00Z",
    retracted_at: "2026-08-02T00:00:00Z",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        can_manage: false,
        status: current,
        history: [current, older, withdrawn],
      }),
    }),
  );
  const el = document.createElement("lab-sharing-status") as LabSharingStatus;
  el.sessionToken = "member";
  document.body.append(el);
  await el.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;

  const history = el.querySelector('[data-testid="lab-sharing-status-history"]')!;
  expect(history).not.toBeNull();
  expect(history.textContent).toContain("Reviewing load is heavy");
  expect(history.textContent).toContain("Cancelled plan");
  // A withdrawn broadcast stays on the record, marked as such.
  expect(history.textContent).toContain("withdrawn");
  // The live one is rendered in full above; repeating it would read as having been said twice.
  expect(history.textContent).not.toContain("Travelling this week");
  expect(el.textContent).toContain("Travelling this week");
  // Reading the archive is not an admin privilege.
  expect(el.querySelector("form")).toBeNull();
});
