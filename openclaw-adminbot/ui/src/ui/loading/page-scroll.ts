// Where each page was scrolled to, so coming back to a page lands where the viewer left it and a
// page opened for the first time starts at its top (the content pane is one element shared by
// every tab, so without this a new page opened at the previous page's offset).
//
// Memory only: it is a convenience for this visit, not something to carry across sign-ins.

const positions = new Map<string, number>();

// A returning page's rows may still be arriving; try again briefly until the pane is tall enough.
const RESTORE_RETRY_DELAYS_MS = [0, 120, 400, 900] as const;

type ScrollPane = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function rememberPageScroll(tab: string, pane: ScrollPane | null | undefined): void {
  if (!pane) {
    return;
  }
  if (pane.scrollTop > 0) {
    positions.set(tab, pane.scrollTop);
  } else {
    positions.delete(tab);
  }
}

export function rememberedPageScroll(tab: string): number {
  return positions.get(tab) ?? 0;
}

export function forgetPageScroll(): void {
  positions.clear();
}

/**
 * Puts the pane back where `tab` was left (or at the top). Gives up as soon as the pane reaches
 * the target, the viewer scrolls it themselves, or `isCurrent` says the page changed again.
 */
export function restorePageScroll(
  tab: string,
  findPane: () => ScrollPane | null | undefined,
  isCurrent: () => boolean,
  schedule: (run: () => void, ms: number) => void = (run, ms) =>
    void globalThis.setTimeout(run, ms),
): void {
  const target = rememberedPageScroll(tab);
  let lastSet: number | undefined;
  const attempt = (index: number) => {
    const pane = findPane();
    if (!pane || !isCurrent()) {
      return;
    }
    if (lastSet !== undefined && Math.abs(pane.scrollTop - lastSet) > 1) {
      // The viewer moved it; their position wins.
      return;
    }
    pane.scrollTop = target;
    lastSet = pane.scrollTop;
    const reached = Math.abs(pane.scrollTop - target) <= 1;
    const nextDelay = RESTORE_RETRY_DELAYS_MS[index + 1];
    if (!reached && nextDelay !== undefined) {
      schedule(() => attempt(index + 1), nextDelay);
    }
  };
  schedule(() => attempt(0), RESTORE_RETRY_DELAYS_MS[0]);
}
