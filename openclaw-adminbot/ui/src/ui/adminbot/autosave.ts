/**
 * Autosave timing, shared by every form that commits itself.
 *
 * Extracted from views/profile.ts when My Projects & Papers grew the same behaviour. One copy
 * rather than two: the debounce is a promise made to the member about how long their typing sits
 * unsaved, and two forms that answered it differently would be a worse tab to use than either.
 *
 * The rule both forms follow: a section commits a beat after typing stops anywhere in its form, or
 * immediately when focus leaves it. One timer per form -- not per field -- so a pause commits every
 * field together in one request instead of racing one write per keystroke-field.
 */

export const AUTOSAVE_DEBOUNCE_MS = 900;

export function scheduleAutosave(
  timer: ReturnType<typeof setTimeout> | undefined,
  set: (next: ReturnType<typeof setTimeout> | undefined) => void,
  commit: () => void,
): void {
  if (timer) {
    clearTimeout(timer);
  }
  set(
    setTimeout(() => {
      set(undefined);
      commit();
    }, AUTOSAVE_DEBOUNCE_MS),
  );
}

/**
 * Commits an edit still inside its debounce window, because focus leaving the form means the
 * member is done with it.
 *
 * With no timer pending there is nothing to flush: leaving a form nobody typed in used to fire a
 * full-record write, a "saved" toast for a save that changed nothing, and an outbound account check
 * per checkable field -- so merely tabbing through the profile page burned GitHub's 60-request
 * unauthenticated hourly budget, which a whole lab shares behind one campus IP.
 */
export function flushAutosave(
  timer: ReturnType<typeof setTimeout> | undefined,
  set: (next: ReturnType<typeof setTimeout> | undefined) => void,
  commit: () => void,
): void {
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  set(undefined);
  commit();
}

/** Cancels a pending commit without running it -- for a draft that must not be sent as it stands. */
export function cancelAutosave(
  timer: ReturnType<typeof setTimeout> | undefined,
  set: (next: ReturnType<typeof setTimeout> | undefined) => void,
): void {
  if (timer) {
    clearTimeout(timer);
    set(undefined);
  }
}

/** True once focus has actually left the form -- not merely moved between two fields inside it. */
export function focusLeftForm(form: HTMLFormElement, event: FocusEvent): boolean {
  const next = event.relatedTarget as Node | null;
  return !next || !form.contains(next);
}
