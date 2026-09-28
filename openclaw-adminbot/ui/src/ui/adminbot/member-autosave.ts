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
