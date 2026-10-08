// Per-member view state (open editors, autosave timers, expanded rows) that must not leak into the
// next signed-in or viewed-as member.
//
// Views hold that state at module level and register their reset here when they load. The app
// calls one function at sign-out and View-as, and never imports the view modules to do it -- an
// import just to reach the reset would pull every lazy page back into the first load. A view that
// never loaded has nothing to reset.

const resets = new Set<() => void>();

export function onViewSessionReset(reset: () => void): void {
  resets.add(reset);
}

export function resetViewSessions(): void {
  for (const reset of resets) {
    reset();
  }
}
