import { afterEach, expect, it, vi } from "vitest";
import { canAccessTab } from "../access.ts";
import { NotificationDrafts } from "./notification-drafts.ts";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function mount() {
  const el = new NotificationDrafts();
  el.baseUrl = "http://localhost:8765";
  el.sessionToken = "synthetic";
  document.body.append(el);
  await el.updateComplete;
  return el;
}
async function fill(el: NotificationDrafts, size?: number) {
  const root = el.shadowRoot!;
  const file = new File(["[]"], "notifications.json", { type: "application/json" });
  if (size !== undefined) {
    Object.defineProperty(file, "size", { value: size });
  }
  Object.defineProperty(file, "text", { value: async () => "[]" });
  const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change"));
  for (const [label, value] of [
    ["Notifications after", "2026-09-01"],
    ["Conference", "NeurIPS"],
  ]) {
    const field = root.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
    field.value = value;
    field.dispatchEvent(new Event("input"));
  }
  await el.updateComplete;
}
it("accepts a 12 MB export and rejects files above 25 MB", async () => {
  const el = await mount();
  await fill(el, 12_221_017);
  expect(el.shadowRoot!.querySelector("[role=alert]")).toBeNull();
  expect(el.shadowRoot!.querySelector<HTMLButtonElement>(".primary")!.disabled).toBe(false);
  await fill(el, 25 * 1024 * 1024 + 1);
  expect(el.shadowRoot!.querySelector("[role=alert]")?.textContent).toContain("25 MB");
  expect(el.shadowRoot!.querySelector<HTMLButtonElement>(".primary")!.disabled).toBe(true);
});
it("is admin-only and generates drafts and downloadable images only on submit", async () => {
  expect(canAccessTab("adminbotNotificationDrafts", "member")).toBe(false);
  expect(canAccessTab("adminbotNotificationDrafts", "admin")).toBe(true);
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => ({
    ok: true,
    json: async () => ({
      announcements: [{ venue: "#NeurIPS2026", text: "Synthetic announcement", paper_count: 1 }],
      images: [{ name: "NeurIPS2026-1.png", data: "c3ludGhldGlj" }],
      warnings: [],
    }),
  }));
  vi.stubGlobal("fetch", fetcher);
  const el = await mount();
  await fill(el);
  expect(fetcher).not.toHaveBeenCalled();
  el.shadowRoot!.querySelector<HTMLButtonElement>(".primary")!.click();
  await vi.waitFor(() =>
    expect(el.shadowRoot!.querySelector("textarea")?.value).toBe("Synthetic announcement"),
  );
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string).conference).toBe("NeurIPS");
  expect(el.shadowRoot!.querySelector("a")?.download).toBe("NeurIPS2026-1.png");
  el.sessionToken = "";
  await el.updateComplete;
  expect(el.shadowRoot!.querySelector("textarea")).toBeNull();
});
it("displays server errors and empty results", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: "Invalid venue" } }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ announcements: [], images: [], warnings: [] }),
    });
  vi.stubGlobal("fetch", fetcher);
  const el = await mount();
  await fill(el);
  el.shadowRoot!.querySelector<HTMLButtonElement>(".primary")!.click();
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("Invalid venue"));
  el.shadowRoot!.querySelector<HTMLButtonElement>(".primary")!.click();
  await vi.waitFor(() =>
    expect(el.shadowRoot!.textContent).toContain("No accepted papers matched"),
  );
});
