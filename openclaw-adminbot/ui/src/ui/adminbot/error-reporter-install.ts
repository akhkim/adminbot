// Attaches the error reporter to the page. Called once, from main.ts, before the app starts.
//
// Kept apart from error-reporter.ts so that file stays free of the window and of the session
// module, and can be tested with a fake fetch and nothing else.
import { loadSettings } from "../storage.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "./auth/session.ts";
import { createErrorReporter } from "./error-reporter.ts";

declare const OPENCLAW_CONTROL_UI_BUILD_ID: string | undefined;

let installed = false;

export function installAdminBotErrorReporter(): void {
  // Wrapped whole: whatever goes wrong while setting this up, the app still has to start.
  try {
    if (installed || typeof window === "undefined" || typeof window.fetch !== "function") {
      return;
    }
    installed = true;
    const pageFetch = window.fetch.bind(window);
    const reporter = createErrorReporter({
      fetch: pageFetch,
      session: () => {
        try {
          const stored = loadStoredMemberSession();
          return stored
            ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(loadSettings()) }
            : null;
        } catch {
          return null;
        }
      },
      page: () => window.location.pathname,
      ...(typeof OPENCLAW_CONTROL_UI_BUILD_ID === "string" && OPENCLAW_CONTROL_UI_BUILD_ID
        ? { build: OPENCLAW_CONTROL_UI_BUILD_ID }
        : {}),
      userAgent: window.navigator.userAgent,
    });
    window.addEventListener("error", (event) => {
      // Not exceptions in this app's code: an event with nothing in it, another origin's script
      // (the browser withholds everything but "Script error."), and the ResizeObserver notice
      // browsers raise during ordinary layout.
      const message = event.message ?? "";
      if (
        (event.error == null && !message) ||
        message === "Script error." ||
        message.startsWith("ResizeObserver loop")
      ) {
        return;
      }
      reporter.reportError("error", event.error ?? event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      reporter.reportError("unhandled_rejection", event.reason);
    });
    window.addEventListener("online", () => reporter.flush());
    window.fetch = reporter.wrapFetch(pageFetch);
  } catch {
    // The page works without a reporter.
  }
}
