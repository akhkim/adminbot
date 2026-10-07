const writes = new WeakMap<HTMLFormElement, Promise<unknown>>();

// Serialize per editor: an older network response must not overwrite a newer edit.
export function saveMemberInBackground(form: HTMLFormElement, write: () => unknown): void {
  const wasConnected = form.isConnected;
  const run = () => (!wasConnected || form.isConnected ? write() : undefined);
  const previous = writes.get(form);
  const pending = previous ? previous.then(run, run) : Promise.resolve(run());
  writes.set(form, pending);
  void pending
    .finally(() => {
      if (writes.get(form) === pending) writes.delete(form);
    })
    .catch(() => undefined);
}

export function waitForMemberSave(form: HTMLFormElement): Promise<unknown> | undefined {
  return writes.get(form);
}

// Debounced autosave for the edit-member popover: every change lands on the record without the
// Save button. Keyed per form so two open popovers never flush each other, and deliberately not
// wired to the add-member form — autosaving there would create a member from a half-typed id.
const timers = new Map<HTMLFormElement, ReturnType<typeof setTimeout>>();

/** (Re)start this form's autosave countdown; `save` runs once the edits stop for `delayMs`. */
export function queueMemberAutosaveTimer(
  form: HTMLFormElement,
  save: () => void,
  delayMs: number,
): void {
  cancelMemberAutosave(form);
  timers.set(
    form,
    setTimeout(() => {
      timers.delete(form);
      save();
    }, delayMs),
  );
}

/** Drop a queued autosave that has not started yet. */
export function cancelMemberAutosave(form: HTMLFormElement): void {
  const pending = timers.get(form);
  if (pending !== undefined) {
    clearTimeout(pending);
    timers.delete(form);
  }
}

/** Drop every queued autosave (leaving the admin view). */
export function cancelAllMemberAutosaves(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}
