// The top-right popup, as one function anything in the UI can call.
//
// `showToast({ title, body })` and something appears in the corner. That is the whole surface, and
// it is a function rather than a component on purpose: the things that need to pop something up --
// a controller that just finished a fetch, a notification that arrived while the member was on a
// different tab, a save that failed -- are not in anybody's render tree and have no host to put
// state on. Making each of them thread a `toasts: Toast[]` field through AppViewState is how a
// popup ends up reimplemented four times with four different animations.
//
// So this module owns its own container, mounted on <body> the first time it is asked for one, and
// renders into it with lit's standalone `render`. Nothing else has to know it exists.
//
// Two behaviors that are easy to get wrong and are settled here:
//
//   - `key` dedupes. A poll that re-reads notifications every minute would otherwise stack five
//     copies of the same sentence; showing the same key again replaces the toast in place and
//     restarts its timer, so a repeat reads as "still true" rather than as five new events.
//   - `duration: 0` means it stays. Anything the member is expected to *act* on must not time out
//     while they are reading it; only acknowledgements get to disappear on their own.
//
// Which is why the corner is bounded. Every one of these is dismissed by hand, and the stack is fed
// by a loop over *all* the member's unread notifications -- so the corner is exactly as tall as the
// backlog. Unbounded, that ran off the bottom of the viewport: the toasts below the fold could not
// be scrolled to and, having no timer, never left, so a member with a long list had notifications
// they could neither read nor close. Three things keep it reachable, and all three matter:
//
//   - the stack scrolls, capped to the viewport, so nothing sits below the fold unreachably;
//   - each toast caps its own text (see .toast__text), so one very long message -- the weekly paper
//     update names every paper an author is on, which for a prolific one is the whole lab -- cannot
//     push the toasts under it off screen or bury its own close button;
//   - two or more toasts get a "Dismiss all" bar, pinned above the stack, because clearing fifteen
//     of them one X at a time is not a thing anybody will do.
import { html, nothing, render } from "lit";
import { icons } from "./icons.ts";

export type ToastTone = "info" | "success" | "warn" | "danger";

export type ToastOptions = {
  title: string;
  /** A sentence or two. Plain text -- this is a popup, not a document. */
  body?: string;
  tone?: ToastTone;
  /** Milliseconds before it dismisses itself. 0 (or omitted with `action` set) means it stays. */
  duration?: number;
  /** One button. More than one and the thing being asked belongs on a page, not in a corner. */
  action?: { label: string; onClick: () => void };
  /** Showing the same key again replaces the toast rather than stacking a second copy. */
  key?: string;
  /** Called when it goes away, however it went away. */
  onDismiss?: () => void;
};

/** How long an ordinary toast lives. Long enough to read two sentences, short enough not to nag. */
export const TOAST_DEFAULT_DURATION_MS = 8_000;

type Toast = ToastOptions & {
  id: string;
  timer?: ReturnType<typeof setTimeout>;
};

const toasts: Toast[] = [];
let container: HTMLElement | null = null;
let counter = 0;

function ensureContainer(): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  if (container?.isConnected) {
    return container;
  }
  container = document.createElement("div");
  container.className = "toasts";
  // Announced but not focus-stealing: a popup that moved focus would interrupt whatever the member
  // was typing, and these arrive unprompted.
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  document.body.append(container);
  return container;
}

// The stack element is omitted entirely when there is nothing in it, rather than hidden with
// `:empty`. lit leaves comment markers inside its parts, so an "empty" stack is not empty to that
// selector -- and the box takes pointer events in order to be scrollable, so left in place it
// would sit in the corner swallowing clicks meant for the page underneath.
function paint(): void {
  const host = ensureContainer();
  if (!host) {
    return;
  }
  render(
    html`${
      toasts.length > 1
        ? html`<div class="toasts__bar">
            <span class="toasts__count">${toasts.length} notifications</span>
            <button
              type="button"
              class="toasts__dismiss-all"
              data-testid="toast-dismiss-all"
              @click=${() => dismissAllToasts()}
            >
              Dismiss all
            </button>
          </div>`
        : nothing
    }
    ${
      toasts.length === 0
        ? nothing
        : html`<div class="toasts__stack">
            ${toasts.map(
              (toast) => html`
                <div
                  class=${`toast toast--${toast.tone ?? "info"}`}
                  data-testid="toast"
                  data-toast-key=${toast.key ?? nothing}
                >
                  <div class="toast__body">
                    <p class="toast__title">${toast.title}</p>
                    ${toast.body ? html`<p class="toast__text">${toast.body}</p>` : nothing}
                    ${
                        toast.action
                          ? html`<button
                              type="button"
                              class="toast__action"
                              data-testid="toast-action"
                              @click=${() => {
                          // Dismiss first: the action usually navigates, and a toast left on screen
                          // through a tab change describes a page the member has already left.
                          dismissToast(toast.id);
                          toast.action?.onClick();
                        }}
                            >
                              ${toast.action.label}
                            </button>`
                          : nothing
                      }
                  </div>
                  <button
                    type="button"
                    class="toast__close"
                    data-testid="toast-close"
                    aria-label="Dismiss notification"
                    @click=${() => dismissToast(toast.id)}
                  >
                    ${icons.x}
                  </button>
                </div>
              `,
            )}
          </div>`
    }`,
    host,
  );
}

function dismissToast(id: string): void {
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index < 0) {
    return;
  }
  const [removed] = toasts.splice(index, 1);
  if (removed?.timer) {
    clearTimeout(removed.timer);
  }
  paint();
  removed?.onDismiss?.();
}

/**
 * Pop something up in the top-right corner. Returns a function that dismisses it early.
 *
 * Safe to call before the app has painted and safe to call from a non-browser context: with no
 * `document` it does nothing and hands back a no-op, so a controller does not have to guard.
 */
export function showToast(options: ToastOptions): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  if (options.key) {
    const existing = toasts.find((toast) => toast.key === options.key);
    if (existing) {
      // Replaced in place rather than removed and re-added: keeping its slot in the stack is what
      // stops a repeating poll shuffling the corner every time it runs.
      dismissToast(existing.id);
    }
  }
  const id = `toast-${(counter += 1)}`;
  // A toast carrying an action is a request, not a notice: it waits.
  const duration =
    options.duration ?? (options.action ? 0 : TOAST_DEFAULT_DURATION_MS);
  const toast: Toast = { ...options, id };
  if (duration > 0) {
    toast.timer = setTimeout(() => dismissToast(id), duration);
  }
  toasts.push(toast);
  paint();
  return () => dismissToast(id);
}

/** Clear the corner. Used on sign-out, where every toast on screen belongs to the previous session. */
export function dismissAllToasts(): void {
  // Drained from the front rather than iterated: dismissToast splices the live array, so walking it
  // would skip every other entry.
  while (toasts.length > 0) {
    dismissToast(toasts[0]!.id);
  }
}
