// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { AdminBotDeadlineBoard, countdown } from "./deadline-board.js";

if (!customElements.get("adminbot-deadline-board")) {
  customElements.define("adminbot-deadline-board", AdminBotDeadlineBoard);
}

describe("deadline board", () => {
  it("formats a live countdown with AoE-safe day and clock fields", () => {
    expect(countdown(2 * 86_400_000 + 3_661_000)).toBe("2d 01:01:01");
    expect(countdown(-1)).toBe("0d 00:00:00");
  });

  it("renders official source links and filters the curated snapshot", async () => {
    const element = document.createElement("adminbot-deadline-board") as AdminBotDeadlineBoard;
    document.body.append(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Anywhere on Earth");
    expect(element.shadowRoot?.querySelectorAll('a[rel="noopener noreferrer"]').length).toBeGreaterThan(0);
    const select = element.shadowRoot?.querySelector<HTMLSelectElement>('select[aria-label="Deadline type"]');
    if (!select) throw new Error("missing filter");
    select.value = "workshop";
    select.dispatchEvent(new Event("change"));
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("NeurIPS 2026 workshop");
    element.remove();
  });
});
