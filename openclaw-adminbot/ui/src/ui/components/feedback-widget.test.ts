import { html } from "lit";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./feedback-widget.ts";
import { AdminbotFeedbackWidget } from "./feedback-widget.ts";

describe("adminbot-feedback-widget", () => {
  let host: HTMLElement;
  let mock: Storage;
  let originalLocalStorage: PropertyDescriptor | undefined;

  // A private, complete Storage per test. Not jsdom's own — the lane shares a
  // worker and other files write to that. Not vi.stubGlobal either: the lane sets
  // unstubGlobals, which wipes stubs before each test runs. defineProperty is the
  // only install that survives, so the descriptor is put back in afterEach; this
  // file used to leave a getItem/setItem-only stand-in behind, which then threw
  // on clear() in whichever file ran next.
  beforeEach(() => {
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    mock = createStorageMock();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: mock,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  // One updateComplete is not always enough under a loaded worker: the shadow
  // root can still be empty, and every interaction below used optional chaining,
  // so a missed click looked like "the widget did not persist anything" instead
  // of "the button was not there yet". Wait for the node, then click it.
  async function settle(el: AdminbotFeedbackWidget, selector: string): Promise<HTMLButtonElement> {
    for (let attempt = 0; attempt < 20; attempt++) {
      await el.updateComplete;
      const node = el.shadowRoot?.querySelector<HTMLButtonElement>(selector);
      if (node) {
        return node;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${selector} in adminbot-feedback-widget`);
  }

  async function renderWidget(): Promise<AdminbotFeedbackWidget> {
    host.innerHTML = "";
    const el = document.createElement("adminbot-feedback-widget");
    el.setAttribute("feature-id", "my-work");
    el.setAttribute("github-file", "https://github.com/example/lab/blob/main/views/my-work.ts");
    host.appendChild(el);
    await el.updateComplete;
    return el as AdminbotFeedbackWidget;
  }

  async function openPanel(el: AdminbotFeedbackWidget): Promise<void> {
    (await settle(el, ".fb__open")).click();
    await el.updateComplete;
  }

  function stars(el: AdminbotFeedbackWidget): NodeListOf<HTMLButtonElement> {
    return (
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".fb__star") ??
      document.querySelectorAll("")
    );
  }

  /** Clicks the nth star, waiting for the panel to actually have rendered them. */
  async function clickStar(el: AdminbotFeedbackWidget, index: number): Promise<void> {
    await settle(el, ".fb__star");
    const star = stars(el)[index];
    if (!star) {
      throw new Error(`Star ${index} missing from adminbot-feedback-widget`);
    }
    star.click();
    await el.updateComplete;
  }

  it("starts collapsed as a single clickable pill", async () => {
    const el = await renderWidget();
    expect(el.shadowRoot?.querySelector(".fb__open")).not.toBeNull();
    expect(stars(el).length).toBe(0);
  });

  it("opens the panel with five star buttons, the comment box, and an info button when clicked", async () => {
    const el = await renderWidget();
    await openPanel(el);
    expect(stars(el).length).toBe(5);
    expect(el.shadowRoot?.querySelector(".fb__input")).not.toBeNull();
    const send = el.shadowRoot?.querySelector<HTMLButtonElement>(".fb__send");
    expect(send).not.toBeNull();
    // No rating yet, so submit stays locked.
    expect(send?.disabled).toBe(true);
    const info = el.shadowRoot?.querySelector<HTMLAnchorElement>(".fb__info");
    expect(info).not.toBeNull();
    expect(info?.getAttribute("href")).toBe(
      "https://github.com/example/lab/blob/main/views/my-work.ts",
    );
    expect(info?.getAttribute("target")).toBe("_blank");
  });

  it("hides the info button when no github file is given", async () => {
    host.innerHTML = "";
    const el = document.createElement("adminbot-feedback-widget");
    el.setAttribute("feature-id", "my-work");
    host.appendChild(el);
    await el.updateComplete;
    await openPanel(el);
    expect(el.shadowRoot?.querySelector(".fb__info")).toBeNull();
  });

  it("previews every star up to the hovered one and clears on leave", async () => {
    const el = await renderWidget();
    await openPanel(el);
    const buttons = stars(el);
    buttons[2]?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await el.updateComplete;
    expect(buttons[0]?.className).toContain("fb__star--on");
    expect(buttons[1]?.className).toContain("fb__star--on");
    expect(buttons[2]?.className).toContain("fb__star--on");
    expect(buttons[3]?.className).not.toContain("fb__star--on");
    el.shadowRoot
      ?.querySelector(".fb__stars")
      ?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    await el.updateComplete;
    expect(buttons[0]?.className).not.toContain("fb__star--on");
  });

  it("records a rating, dispatches a feedback event, and unlocks submit", async () => {
    const el = await renderWidget();
    await openPanel(el);
    let detail: unknown = null;
    el.addEventListener("feedback", (event) => {
      detail = (event as CustomEvent).detail;
    });
    await clickStar(el, 2);
    await el.updateComplete;
    // `submitted` is false here on purpose: the host only writes a rating the member actually
    // pressed Send on, so clicking through the stars cannot file four ratings.
    expect(detail).toEqual({
      featureId: "my-work",
      rating: 3,
      comment: "",
      githubFile: "https://github.com/example/lab/blob/main/views/my-work.ts",
      submitted: false,
    });
    const send = el.shadowRoot?.querySelector<HTMLButtonElement>(".fb__send");
    expect(send?.disabled).toBe(false);
  });

  it("persists the rating to localStorage", async () => {
    const el = await renderWidget();
    await openPanel(el);
    await clickStar(el, 4);
    const raw = mock.getItem("openclaw:feedback:v2:my-work");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? "{}")).toEqual({
      rating: 5,
      comment: "",
      submitted: false,
      dismissed: false,
    });
  });

  it("restores an existing vote and keeps the send button when it was never submitted", async () => {
    mock.setItem("openclaw:feedback:v2:my-work", JSON.stringify({ rating: 4, comment: "nice" }));
    const el = await renderWidget();
    await openPanel(el);
    expect(stars(el)[3]?.className).toContain("fb__star--on");
    // A stored rating is not a submission: the button must come back, not vanish.
    expect(el.shadowRoot?.querySelector(".fb__send")).not.toBeNull();
  });

  it("renders nothing once the widget was dismissed on a previous submit", async () => {
    mock.setItem(
      "openclaw:feedback:v2:my-work",
      JSON.stringify({ rating: 4, comment: "nice", submitted: true, dismissed: true }),
    );
    const el = await renderWidget();
    // The whole widget is gone: no pill, no panel.
    expect(el.shadowRoot?.querySelector(".fb__open")).toBeNull();
    expect(stars(el).length).toBe(0);
  });

  it("dismisses the whole widget after sending", async () => {
    const el = await renderWidget();
    await openPanel(el);
    await clickStar(el, 0);
    await el.updateComplete;
    const input = el.shadowRoot?.querySelector<HTMLTextAreaElement>(".fb__input");
    expect(input).not.toBeNull();
    input!.value = "great";
    input!.dispatchEvent(new Event("input"));
    (await settle(el, ".fb__send")).click();
    await el.updateComplete;
    // Send dismisses the entire widget and persists the vote plus dismissal.
    expect(el.shadowRoot?.querySelector(".fb__open")).toBeNull();
    expect(stars(el).length).toBe(0);
    expect(JSON.parse(mock.getItem("openclaw:feedback:v2:my-work") ?? "{}")).toEqual({
      rating: 1,
      comment: "great",
      submitted: true,
      dismissed: true,
    });
  });

  it("closes the panel back to the pill via the close button", async () => {
    const el = await renderWidget();
    await openPanel(el);
    el.shadowRoot?.querySelector<HTMLButtonElement>(".fb__close")?.click();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".fb__open")).not.toBeNull();
    expect(stars(el).length).toBe(0);
  });

  it("collapses back to the pill when the feature id changes (tab navigation)", async () => {
    const el = await renderWidget();
    await openPanel(el);
    expect(stars(el).length).toBe(5);
    // Simulate navigating to another tab: app-render reuses the element and swaps feature-id.
    el.setAttribute("feature-id", "reimbursements");
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".fb__open")).not.toBeNull();
    expect(stars(el).length).toBe(0);
  });
});
