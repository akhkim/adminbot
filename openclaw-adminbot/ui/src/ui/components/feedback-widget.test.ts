import { html } from "lit";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./feedback-widget.ts";
import { AdminbotFeedbackWidget } from "./feedback-widget.ts";

describe("adminbot-feedback-widget", () => {
  let host: HTMLElement;
  let storage: Storage;
  let originalLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    // Not vi.stubGlobal: the lane sets unstubGlobals, which wipes stubs before
    // each test and would leave the widget writing to jsdom's storage instead of
    // this mock. defineProperty survives that — but it also survives the file, so
    // the descriptor is restored in afterEach, and the mock is a complete Storage
    // rather than a getItem/setItem pair that later files then call clear() on.
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    storage = createStorageMock();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: storage,
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
    el.shadowRoot?.querySelector<HTMLButtonElement>(".fb__open")?.click();
    await el.updateComplete;
  }

  function stars(el: AdminbotFeedbackWidget): NodeListOf<HTMLButtonElement> {
    return (
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".fb__star") ??
      document.querySelectorAll("")
    );
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
    stars(el)[2]?.click();
    await el.updateComplete;
    expect(detail).toEqual({
      featureId: "my-work",
      rating: 3,
      comment: "",
      githubFile: "https://github.com/example/lab/blob/main/views/my-work.ts",
    });
    const send = el.shadowRoot?.querySelector<HTMLButtonElement>(".fb__send");
    expect(send?.disabled).toBe(false);
  });

  it("persists the rating to localStorage", async () => {
    const el = await renderWidget();
    await openPanel(el);
    stars(el)[4]?.click();
    const raw = storage.getItem("openclaw:feedback:v2:my-work");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? "{}")).toEqual({
      rating: 5,
      comment: "",
      submitted: false,
      dismissed: false,
    });
  });

  it("restores an existing vote and keeps the send button when it was never submitted", async () => {
    storage.setItem("openclaw:feedback:v2:my-work", JSON.stringify({ rating: 4, comment: "nice" }));
    const el = await renderWidget();
    await openPanel(el);
    expect(stars(el)[3]?.className).toContain("fb__star--on");
    // A stored rating is not a submission: the button must come back, not vanish.
    expect(el.shadowRoot?.querySelector(".fb__send")).not.toBeNull();
  });

  it("renders nothing once the widget was dismissed on a previous submit", async () => {
    storage.setItem(
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
    stars(el)[0]?.click();
    await el.updateComplete;
    const input = el.shadowRoot?.querySelector<HTMLTextAreaElement>(".fb__input");
    expect(input).not.toBeNull();
    input!.value = "great";
    input!.dispatchEvent(new Event("input"));
    el.shadowRoot?.querySelector<HTMLButtonElement>(".fb__send")!.click();
    await el.updateComplete;
    // Send dismisses the entire widget and persists the vote plus dismissal.
    expect(el.shadowRoot?.querySelector(".fb__open")).toBeNull();
    expect(stars(el).length).toBe(0);
    expect(JSON.parse(storage.getItem("openclaw:feedback:v2:my-work") ?? "{}")).toEqual({
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
