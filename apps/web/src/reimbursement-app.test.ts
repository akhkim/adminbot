// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { AdminBotReimbursementApp } from "./reimbursement-app.js";

if (!customElements.get("adminbot-reimbursement-app")) {
  customElements.define("adminbot-reimbursement-app", AdminBotReimbursementApp);
}

describe("AdminBotReimbursementApp", () => {
  it("renders the local-only notice and a reviewable packet", async () => {
    const element = document.createElement("adminbot-reimbursement-app") as AdminBotReimbursementApp;
    element.client = {
      converse: vi.fn(async () => ({
        assistantMessage: "Please review the extracted facts.",
        draft: {
          claimantName: "Synthetic Claimant", claimantEmail: "claimant@example.com",
          claimantAddress: "1 Example Street", claimantTitle: "Researcher",
          tripTitle: "Workshop", tripDates: "2026-08-01", tripLocation: "Toronto",
          purpose: "Present research", currency: "CAD",
          expenses: [{ date: "2026-08-01", description: "Rail", category: "rail", amount: 40, currency: "CAD" }],
        },
        missingFields: [], ready: true, receiptNames: ["receipt.pdf"],
      })),
      generate: vi.fn(async () => ({ artifacts: [], warnings: [] })),
    };
    document.body.append(element); await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Receipt bytes are sent only to the loopback");

    const textarea = element.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "Please prepare my synthetic claim";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    element.shadowRoot?.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Synthetic Claimant"));
    expect(element.shadowRoot?.textContent).toContain("Ready to generate");
    element.remove();
  });
});
