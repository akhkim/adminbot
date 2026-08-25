import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissAllToasts, showToast, TOAST_DEFAULT_DURATION_MS } from "./toast.ts";

function toasts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-testid='toast']")];
}

afterEach(() => {
  dismissAllToasts();
  vi.useRealTimers();
});

describe("showToast", () => {
  it("mounts its own container and renders the title and body", () => {
    showToast({ title: "Please join the next Monday meeting", body: "You have missed two." });
    const [toast] = toasts();
    expect(toast?.querySelector(".toast__title")?.textContent).toContain("Monday meeting");
    expect(toast?.querySelector(".toast__text")?.textContent).toContain("missed two");
    // Announced without stealing focus: these arrive unprompted, over whatever the member is doing.
    expect(document.querySelector(".toasts")?.getAttribute("aria-live")).toBe("polite");
  });

  it("stacks unkeyed toasts and replaces keyed ones in place", () => {
    showToast({ title: "One" });
    showToast({ title: "Two" });
    expect(toasts()).toHaveLength(2);

    showToast({ key: "same", title: "First copy" });
    showToast({ key: "same", title: "Second copy" });
    const keyed = toasts().filter((toast) => toast.dataset.toastKey === "same");
    // A poll that re-reads the same notification every minute must not build a wall of duplicates.
    expect(keyed).toHaveLength(1);
    expect(keyed[0]?.textContent).toContain("Second copy");
  });

  it("times out on its own, but never when it carries an action", () => {
    vi.useFakeTimers();
    showToast({ title: "Saved" });
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_DEFAULT_DURATION_MS + 1);
    expect(toasts()).toHaveLength(0);

    // Something the member is asked to act on must not vanish while they are reading it.
    showToast({ title: "Join the meeting", action: { label: "Open", onClick: () => {} } });
    vi.advanceTimersByTime(TOAST_DEFAULT_DURATION_MS * 10);
    expect(toasts()).toHaveLength(1);
  });

  it("runs the action, dismisses first, and reports the dismissal once", () => {
    const order: string[] = [];
    showToast({
      title: "Join the meeting",
      action: { label: "Open", onClick: () => order.push("action") },
      onDismiss: () => order.push("dismiss"),
    });
    document.querySelector<HTMLButtonElement>("[data-testid='toast-action']")?.click();
    // Dismissed before the action runs: the action usually navigates, and a toast left on screen
    // through a tab change describes a page the member has already left.
    expect(order).toEqual(["dismiss", "action"]);
    expect(toasts()).toHaveLength(0);
  });

  it("closes on the close button, and the returned handle is idempotent", () => {
    const dismissed = vi.fn();
    const close = showToast({ title: "Notice", onDismiss: dismissed });
    document.querySelector<HTMLButtonElement>("[data-testid='toast-close']")?.click();
    expect(toasts()).toHaveLength(0);
    expect(dismissed).toHaveBeenCalledTimes(1);
    // The caller's handle can fire after the member already closed it; that must not double-report.
    close();
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it("clears the corner on demand", () => {
    showToast({ title: "One", duration: 0 });
    showToast({ title: "Two", duration: 0 });
    dismissAllToasts();
    expect(toasts()).toHaveLength(0);
  });
});
