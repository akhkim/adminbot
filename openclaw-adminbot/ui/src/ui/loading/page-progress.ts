// <page-progress>: the thin line across the top of the page while something the viewer asked for
// is in flight (a page's code, its reads, a save). It listens to page-activity.ts itself, so the
// app shell does not re-render to move it.
import { notePageIntent, pageActivityCount, subscribePageActivity } from "./page-activity.ts";

// Work that finishes inside this never shows the line at all.
export const PAGE_PROGRESS_SHOW_DELAY_MS = 180;
// Once shown, the line stays long enough to be seen rather than blink.
export const PAGE_PROGRESS_MIN_VISIBLE_MS = 320;

export type PageProgressTimers = {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
};

const realTimers: PageProgressTimers = {
  set: (run, ms) => globalThis.setTimeout(run, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Turns "how many things are in flight" into "is the line showing", with a delay before it
 * appears and a minimum time on screen. Kept apart from the element so it can be tested without
 * a browser.
 */
export function createPageProgressController(
  onVisible: (visible: boolean) => void,
  timers: PageProgressTimers = realTimers,
) {
  let visible = false;
  let shownAt = 0;
  let showTimer: unknown;
  let hideTimer: unknown;
  const cancel = (handle: unknown) => {
    if (handle !== undefined) {
      timers.clear(handle);
    }
  };
  const setVisible = (next: boolean) => {
    if (visible === next) {
      return;
    }
    visible = next;
    if (next) {
      shownAt = timers.now();
    }
    onVisible(next);
  };
  return {
    update(active: number): void {
      if (active > 0) {
        cancel(hideTimer);
        hideTimer = undefined;
        if (!visible && showTimer === undefined) {
          showTimer = timers.set(() => {
            showTimer = undefined;
            setVisible(true);
          }, PAGE_PROGRESS_SHOW_DELAY_MS);
        }
        return;
      }
      cancel(showTimer);
      showTimer = undefined;
      if (visible && hideTimer === undefined) {
        const remaining = PAGE_PROGRESS_MIN_VISIBLE_MS - (timers.now() - shownAt);
        hideTimer = timers.set(
          () => {
            hideTimer = undefined;
            setVisible(false);
          },
          Math.max(0, remaining),
        );
      }
    },
    dispose(): void {
      cancel(showTimer);
      cancel(hideTimer);
      showTimer = undefined;
      hideTimer = undefined;
    },
  };
}

const BaseElement: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

export class PageProgress extends BaseElement {
  private controller: ReturnType<typeof createPageProgressController> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly onIntent = () => notePageIntent();

  connectedCallback(): void {
    this.setAttribute("aria-hidden", "true");
    if (!this.firstElementChild) {
      const bar = document.createElement("span");
      bar.className = "page-progress__bar";
      this.append(bar);
    }
    this.controller = createPageProgressController((visible) => {
      this.toggleAttribute("active", visible);
    });
    this.unsubscribe = subscribePageActivity((active) => this.controller?.update(active));
    this.controller.update(pageActivityCount());
    // Capture phase: the gesture is noted before the handler it triggers starts any request.
    window.addEventListener("pointerdown", this.onIntent, { capture: true, passive: true });
    window.addEventListener("keydown", this.onIntent, { capture: true, passive: true });
    window.addEventListener("submit", this.onIntent, { capture: true });
    window.addEventListener("popstate", this.onIntent);
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.removeAttribute("active");
    window.removeEventListener("pointerdown", this.onIntent, { capture: true });
    window.removeEventListener("keydown", this.onIntent, { capture: true });
    window.removeEventListener("submit", this.onIntent, { capture: true });
    window.removeEventListener("popstate", this.onIntent);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("page-progress")) {
  customElements.define("page-progress", PageProgress);
}
