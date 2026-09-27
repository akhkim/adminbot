/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { saveMemberInBackground, waitForMemberSave } from "./member-autosave.ts";
it("serializes writes and abandons a queued write when the editor is removed", async () => {
  const form = document.createElement("form");
  document.body.append(form);
  const calls: number[] = [];
  let finish!: () => void;
  saveMemberInBackground(form, () => {
    calls.push(1);
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  saveMemberInBackground(form, () => {
    calls.push(2);
  });
  expect(calls).toEqual([1]);
  finish();
  await waitForMemberSave(form);
  expect(calls).toEqual([1, 2]);
  saveMemberInBackground(
    form,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  saveMemberInBackground(form, () => {
    calls.push(3);
  });
  form.remove();
  finish();
  await waitForMemberSave(form);
  expect(calls).toEqual([1, 2]);
});
