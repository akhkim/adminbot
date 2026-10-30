import { afterEach, expect, it, vi } from "vitest";
import { OfflineAccess } from "./offline-access.ts";

const retry = vi.hoisted(() => vi.fn());
vi.mock("./draft-sync.ts", () => ({ pendingDraftCount: () => 1, retryDraftSync: retry }));
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("uses shared page buttons and retries from the offline panel", async () => {
  const panel = new OfflineAccess();
  document.body.append(panel);
  await panel.updateComplete;
  expect(panel.shadowRoot).toBeNull();
  const buttons = [...panel.querySelectorAll("button")];
  expect(buttons).toHaveLength(2);
  expect(
    buttons.every((button) => button.classList.contains("btn") && button.type === "button"),
  ).toBe(true);
  buttons[0].click();
  expect(retry).toHaveBeenCalledOnce();
  expect(panel.textContent).toContain("1 draft awaiting sync or review.");
});

it("stays out of the way while online with nothing waiting, unless the page asks for it", async () => {
  const draftSync = await import("./draft-sync.ts");
  const count = vi.spyOn(draftSync, "pendingDraftCount").mockReturnValue(0);
  const panel = new OfflineAccess();
  document.body.append(panel);
  await panel.updateComplete;
  expect(panel.hidden).toBe(true);
  expect(panel.querySelector("details")).toBeNull();
  panel.always = true;
  await panel.updateComplete;
  expect(panel.hidden).toBe(false);
  expect(panel.querySelector("summary")?.textContent).toContain("Offline access");
  count.mockRestore();
});
