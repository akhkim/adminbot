// The Membership grid and the call-queue preview, kept between page views.
//
// Both pages read a Google spreadsheet through gog, which takes seconds and, with several admins
// on the page, ran once per viewer: under load the reads queued behind each other until a page
// took 14 s. Only these two GET views are kept. Every write path (a grid edit, an onboard, a call
// push) still reads the sheet fresh, because it plans row positions from what is there now.
import { createCachedRead, type CachedRead } from "../kernel/cached-read.js";

// A sheet the lab edits by hand can be a minute behind on screen; the view says when it was read.
const SHEET_FRESH_MS = 60_000;
// Past that, the older view is drawn at once while a new read runs behind it.
const SHEET_STALE_MS = 10 * 60_000;

// Requests that can change what either view shows, besides an executed proposal: a grid edit or
// onboard (/membership), and a new or edited meeting request, which the call queue lists
// (/logistics).
const SHEET_WRITE_PREFIXES = ["/membership", "/logistics"];

export type SheetPageReads = {
  memberSheet<T>(load: () => Promise<T>): Promise<T>;
  callSheet<T>(load: () => Promise<T>, keep: (value: T) => boolean): Promise<T>;
  /** Drop both views, and any read already under way. */
  invalidate(): void;
  /** Called after every request; drops both views after a write that can change them. */
  noteRequest(method: string | undefined, path: string): void;
  /**
   * Reads both views now and again every `intervalMs`, and again right after each invalidate, so
   * the page is handed a kept view instead of waiting seconds on the sheet. Returns a stop.
   */
  keepWarm(loaders: SheetViewLoaders, intervalMs: number): () => void;
};

export type SheetViewLoaders = {
  member?: () => Promise<unknown>;
  call?: { load: () => Promise<unknown>; keep: (value: unknown) => boolean };
};

export function createSheetPageReads(options: { now?: () => number } = {}): SheetPageReads {
  // One CachedRead per view, made on first use: the loader closes over the route's own
  // context, which is the same object for the life of the process.
  let member: CachedRead<unknown> | undefined;
  let call: CachedRead<unknown> | undefined;
  const timing = {
    freshMs: SHEET_FRESH_MS,
    staleMs: SHEET_STALE_MS,
    ...(options.now ? { now: options.now } : {}),
  };
  let warm: (() => void) | undefined;
  const reads: SheetPageReads = {
    memberSheet<T>(load: () => Promise<T>) {
      member ??= createCachedRead<unknown>(load, timing);
      return member.read() as Promise<T>;
    },
    callSheet<T>(load: () => Promise<T>, keep: (value: T) => boolean) {
      call ??= createCachedRead<unknown>(load, { ...timing, keep: (value) => keep(value as T) });
      return call.read() as Promise<T>;
    },
    invalidate() {
      member?.invalidate();
      call?.invalidate();
      warm?.();
    },
    noteRequest(method, path) {
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        return;
      }
      if (SHEET_WRITE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        reads.invalidate();
      }
    },
    keepWarm(loaders, intervalMs) {
      // Made here rather than on first view, so the first viewer after a restart is served too.
      // A route's own loader is then never used; it reads the same sheet the same way.
      if (loaders.member) {
        member ??= createCachedRead<unknown>(loaders.member, timing);
      }
      if (loaders.call) {
        call ??= createCachedRead<unknown>(loaders.call.load, { ...timing, keep: loaders.call.keep });
      }
      // A failed read is not kept and is retried on the next tick; the page then reads for itself.
      warm = () => {
        member?.refresh().catch(() => {});
        call?.refresh().catch(() => {});
      };
      warm();
      const timer = setInterval(warm, intervalMs);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        warm = undefined;
      };
    },
  };
  return reads;
}
