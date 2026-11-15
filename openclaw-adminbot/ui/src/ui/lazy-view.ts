// Control UI module implements lazy view behavior.
import { html, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { trackPageActivity } from "./loading/page-activity.ts";
import { registerPagePrefetch } from "./loading/page-prefetch.ts";
import { renderSkeleton } from "./loading/skeleton.ts";
import type { Tab } from "./navigation.ts";

type LazyState<T> = {
  mod: T | null;
  promise: Promise<void> | null;
  error: unknown;
  hasError: boolean;
};

export type LazyView<T> = {
  read: () => T | null;
  retry: () => void;
  error: () => unknown;
  hasError: () => boolean;
  pending: () => boolean;
  /** Starts the download without drawing anything; a later `read` finds the module ready. */
  prefetch: () => void;
};

export type LazyViewOptions = {
  /**
   * The tabs this view is drawn on. Pointing at one of their sidebar links, or the idle pass after
   * first paint, loads the module ahead of the click (loading/page-prefetch.ts).
   */
  tabs?: readonly Tab[];
};

let hostUpdate: (() => void) | undefined;

// Views created outside app-render.ts (the AdminBot surfaces) repaint through the app shell's
// update, which it registers here on every render.
export function setLazyViewHost(update: (() => void) | undefined): void {
  hostUpdate = update;
}

export const notifyLazyViewHost = (): void => hostUpdate?.();

export function createLazyView<T>(
  loader: () => Promise<T>,
  onChange?: () => void,
  options?: LazyViewOptions,
): LazyView<T> {
  const state: LazyState<T> = { mod: null, promise: null, error: undefined, hasError: false };

  // `silent` is a prefetch: nobody is waiting on it, so it neither draws the progress line nor
  // repaints the app when it lands, and a failure is forgotten so the real visit tries again.
  const load = (silent = false) => {
    silentInFlight = silent;
    waiting = false;
    let started: Promise<T>;
    try {
      started = loader();
    } catch (error) {
      started = Promise.reject(error);
    }
    const settled = started
      .then(
        (mod) => {
          state.mod = mod;
          state.error = undefined;
          state.hasError = false;
        },
        (error: unknown) => {
          state.promise = null;
          if (silent && !waiting) {
            return;
          }
          state.error = error;
          state.hasError = true;
        },
      )
      .finally(() => {
        if (!silent || waiting) {
          onChange?.();
        }
      });
    state.promise = settled;
    if (!silent) {
      void trackPageActivity(settled);
    }
  };
  // Set when a page asked for the module while a prefetch was already fetching it: that page is
  // now showing a placeholder and must be repainted (or shown the error) when the fetch settles.
  let waiting = false;
  let silentInFlight = false;

  const view: LazyView<T> = {
    read: () => {
      if (state.mod !== null) {
        return state.mod;
      }
      if (!state.promise && !state.hasError) {
        load();
      } else if (state.promise && silentInFlight && !waiting) {
        waiting = true;
        void trackPageActivity(state.promise);
      }
      return null;
    },
    retry: () => {
      if (state.mod !== null) {
        return;
      }
      state.error = undefined;
      state.hasError = false;
      state.promise = null;
      load();
      onChange?.();
    },
    error: () => state.error,
    hasError: () => state.hasError,
    pending: () => state.promise !== null,
    prefetch: () => {
      if (state.mod === null && !state.promise && !state.hasError) {
        load(true);
      }
    },
  };
  if (options?.tabs?.length) {
    registerPagePrefetch(options.tabs, view.prefetch);
  }
  return view;
}

function formatLazyViewError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return t("lazyView.unknownError");
}

export function renderLazyView<M, R>(view: LazyView<M>, render: (mod: M) => R): R | TemplateResult {
  const mod = view.read();
  if (mod !== null) {
    return render(mod);
  }

  if (view.hasError()) {
    const error = view.error();
    return html`
      <section class="card lazy-view-state lazy-view-state--error">
        <div class="card-title">${t("lazyView.errorTitle")}</div>
        <div class="card-sub">${t("lazyView.errorSubtitle")}</div>
        <div class="callout danger" style="margin-top: 12px;">${formatLazyViewError(error)}</div>
        <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
          <button class="btn primary" @click=${() => globalThis.location.reload()}>
            ${t("common.reload")}
          </button>
          <button class="btn" @click=${() => view.retry()}>${t("lazyView.retry")}</button>
        </div>
      </section>
    `;
  }

  // The page's code is on its way. Quiet lines after a short delay, not a boxed "Loading" card:
  // a prefetched or cached module arrives before the placeholder would have appeared at all.
  return html`
    <section class="lazy-view-state lazy-view-state--loading">
      ${renderSkeleton({ testId: "lazy-view-loading", label: t("lazyView.loadingTitle") })}
    </section>
  `;
}
