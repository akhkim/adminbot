import { afterEach, expect, it, vi } from "vitest";
import type { LabSharingHowTo } from "./lab-sharing-how-to.ts";
import "./lab-sharing-how-to.ts";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("renders answers as text, supports retry, and discards a late answer after logout", async () => {
  vi.useFakeTimers();
  let finish: (value: unknown) => void = () => {};
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("internal path"))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        answered: true,
        answer: "<script>bad()</script>",
        sources: ["Recordings"],
      }),
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const el = document.createElement("lab-sharing-how-to") as LabSharingHowTo;
  el.sessionToken = "member";
  document.body.append(el);
  await el.updateComplete;
  const submit = async () => {
    const input = el.querySelector("textarea")!;
    input.value = "Where are recordings?";
    input.dispatchEvent(new Event("input"));
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    await el.updateComplete;
  };
  await submit();
  expect(el.textContent).toContain("Try again");
  expect(el.textContent).not.toContain("internal path");
  await submit();
  expect(el.textContent).toContain("<script>bad()</script>");
  expect(el.querySelector("script")).toBeNull();
  expect(el.textContent).toContain("Recordings");
  await submit();
  el.sessionToken = "";
  await el.updateComplete;
  finish({
    ok: true,
    json: async () => ({ answered: true, answer: "late private answer", sources: [] }),
  });
  await vi.advanceTimersByTimeAsync(0);
  await el.updateComplete;
  expect(el.textContent?.trim()).toBe("");
});
