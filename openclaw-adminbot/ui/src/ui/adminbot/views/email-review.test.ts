/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { gmailThreadUrl, renderAdminBotEmailReview } from "./email-review.ts";

const review = {
  message_id: "message-1",
  thread_id: "thread/1",
  sender: "notifications@openreview.net",
  subject: "Reviews released",
  category: "paperflow_bcc",
  reason: "the sender is not a trusted lab address",
  received_at: "2026-09-03T21:04:00.000Z",
  updated_at: "2026-09-03T21:05:00.000Z",
};

const candidates = [
  {
    paper_id: "paper-1",
    title: "Reliable Research Agents",
    stage: "reviews_out",
    stage_label: "Reviews",
    venue: "ICLR 2027",
  },
];

describe("email review queue", () => {
  it("explains why a real message was held and links to its Gmail thread", () => {
    const container = document.createElement("div");
    render(
      renderAdminBotEmailReview({
        reviews: [review],
        candidates,
        busyActionId: null,
        onResolve: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("Reviews released");
    expect(container.textContent).toContain("the sender is not a trusted lab address");
    expect(container.textContent?.replace(/\s+/gu, " ")).toContain(
      "Reliable Research Agents — Reviews · ICLR 2027",
    );
    expect(container.querySelector<HTMLAnchorElement>('a[target="_blank"]')?.href).toBe(
      gmailThreadUrl("thread/1"),
    );
  });

  it("submits only the selected current paper and stage", () => {
    const onResolve = vi.fn();
    const container = document.createElement("div");
    render(
      renderAdminBotEmailReview({
        reviews: [review],
        candidates,
        busyActionId: null,
        onResolve,
      }),
      container,
    );

    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onResolve).toHaveBeenCalledWith("message-1", {
      kind: "paperflow_evidence",
      paper_id: "paper-1",
      stage: "reviews_out",
    });
  });

  it("can dismiss unrelated mail without offering a fake attachment target", () => {
    const onResolve = vi.fn();
    const container = document.createElement("div");
    render(
      renderAdminBotEmailReview({
        reviews: [review],
        candidates: [],
        busyActionId: null,
        onResolve,
      }),
      container,
    );

    const attach = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Attach"),
    );
    expect(attach?.disabled).toBe(true);
    const dismiss = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Not paper evidence"),
    );
    dismiss?.click();
    expect(onResolve).toHaveBeenCalledWith("message-1", { kind: "dismissed" });
  });
});
