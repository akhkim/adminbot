import { afterEach, expect, it, vi } from "vitest";
import { canAccessTab } from "../access.ts";
import { ReferenceChecker } from "./reference-checker.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  const el = new ReferenceChecker();
  el.baseUrl = "http://localhost:8765";
  el.sessionToken = "synthetic-admin";
  document.body.append(el);
  await el.updateComplete;
  return el;
}

async function choose(el: ReferenceChecker, files: File[]) {
  const input = el.shadowRoot!.querySelector("input")!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
  await el.updateComplete;
}

it("restricts the tab to admins and rejects non-PDF selections and multiple drops", async () => {
  expect(canAccessTab("adminbotReferenceChecker", "admin")).toBe(true);
  expect(canAccessTab("adminbotReferenceChecker", "member")).toBe(false);
  expect(canAccessTab("adminbotReferenceChecker", "anonymous")).toBe(false);
  const el = await mount();
  await choose(el, [new File(["text"], "notes.txt", { type: "text/plain" })]);
  expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(true);
  expect(el.shadowRoot!.textContent).toContain("Choose one PDF");
  const event = new Event("drop", { cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files: [new File(["x"], "a.pdf"), new File(["x"], "b.pdf")] },
  });
  el.shadowRoot!.querySelector(".drop")!.dispatchEvent(event);
  await el.updateComplete;
  expect(event.defaultPrevented).toBe(true);
  expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(true);
});

it("uploads a dropped PDF only on Submit, renders findings, and permits repeat scans", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      citation_count: 3,
      uncertain_count: 1,
      findings: [{ citation: "Synthetic citation", status: "fake", explanation: "Not located" }],
    }),
  });
  vi.stubGlobal("fetch", fetcher);
  const el = await mount();
  const pdf = new File(["%PDF-synthetic"], "paper.pdf", { type: "application/pdf" });
  const drop = new Event("drop", { cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [pdf] } });
  el.shadowRoot!.querySelector(".drop")!.dispatchEvent(drop);
  await el.updateComplete;
  expect(fetcher).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++) {
    el.shadowRoot!.querySelector("button")!.click();
    await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("Synthetic citation"));
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]).toEqual([
    "http://localhost:8765/reference-check/pdf?consent=send-to-gptzero",
    expect.objectContaining({
      body: pdf,
      headers: { Authorization: "Bearer synthetic-admin", "Content-Type": "application/pdf" },
    }),
  ]);
  el.sessionToken = "";
  await el.updateComplete;
  expect(el.shadowRoot!.textContent).not.toContain("Synthetic citation");
});

it("shows errors and clears previous results when choosing another file", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "GPTZero is unavailable." } }),
    }),
  );
  const el = await mount();
  await choose(el, [new File(["%PDF-synthetic"], "paper.pdf")]);
  el.shadowRoot!.querySelector("button")!.click();
  await vi.waitFor(() =>
    expect(el.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain(
      "GPTZero is unavailable.",
    ),
  );
  await choose(el, [new File(["%PDF-synthetic"], "next.pdf")]);
  expect(el.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
});

it("disables duplicate submissions while running and distinguishes empty results", async () => {
  let finish!: (value: unknown) => void;
  const fetcher = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const el = await mount();
  await choose(el, [new File(["%PDF-synthetic"], "paper.pdf")]);
  el.shadowRoot!.querySelector("button")!.click();
  await el.updateComplete;
  expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(true);
  expect(el.shadowRoot!.querySelector('[role="status"]')).not.toBeNull();
  el.shadowRoot!.querySelector("button")!.click();
  expect(fetcher).toHaveBeenCalledOnce();
  finish({ ok: true, json: async () => ({ citation_count: 0, uncertain_count: 0, findings: [] }) });
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("could not be assessed"));
  expect(el.shadowRoot!.textContent).not.toContain("No citations were flagged");
});
