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
