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
    vi
      .fn()
      .mockResolvedValue({
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
