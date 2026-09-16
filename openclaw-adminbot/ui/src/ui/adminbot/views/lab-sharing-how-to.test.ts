import { afterEach, expect, it, vi } from "vitest";
import { taskActivities } from "../task-request.ts";
import "./lab-sharing-how-to.ts";
import "./task-status.ts";
import { LabSharingHowTo } from "./lab-sharing-how-to.ts";
import { AdminBotTaskStatus } from "./task-status.ts";
// isolate:false may retain a production tag registered by an earlier module evaluation.
// Unique subclasses keep this test's elements bound to the same task registry as its imports.
class ReconnectGuidebook extends LabSharingHowTo {}
class ReconnectTaskStatus extends AdminBotTaskStatus {}
customElements.define("test-guidebook-reconnect", ReconnectGuidebook);
customElements.define("test-guidebook-task-status", ReconnectTaskStatus);
afterEach(() => {
  document.body.replaceChildren();
  for (const task of taskActivities.values()) task.detach();
  taskActivities.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("renders answers as text, supports retry, and discards a late answer after logout", async () => {
  let finish: (value: unknown) => void = () => {};
  const answer = vi
    .fn()
    .mockRejectedValueOnce(new Error("internal path"))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answered: true,
          answer: "<script>bad()</script>",
          sources: ["Recordings"],
        }),
      ),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const fetcher = vi.fn((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, "http://localhost:8765").pathname;
    if (path === "/tasks") return Promise.resolve(new Response(JSON.stringify({ tasks: [] })));
    if (path === "/lab-sharing/ask") return answer();
    return Promise.reject(new Error(`Unexpected test route: ${path}`));
  });
  vi.stubGlobal("fetch", fetcher);
  const el = document.createElement("test-guidebook-reconnect") as LabSharingHowTo;
  el.sessionToken = "member";
  el.baseUrl = "http://localhost:8765";
  const status = document.createElement("test-guidebook-task-status");
  document.body.append(status, el);
  await el.updateComplete;
  const submit = async () => {
    const input = el.querySelector("textarea")!;
    input.value = "Where are recordings?";
    input.dispatchEvent(new Event("input"));
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;
  };
  await submit();
  await vi.waitFor(() => expect(status.textContent).toContain("Reconnect"));
  expect(el.textContent).not.toContain("internal path");
  status.querySelector("button")!.click();
  await vi.waitFor(() => expect(el.textContent).toContain("<script>bad()</script>"));
  expect(el.querySelector("script")).toBeNull();
  expect(el.textContent).toContain("Recordings");
  await submit();
  await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(3));
  el.sessionToken = "";
  await el.updateComplete;
  finish(
    new Response(JSON.stringify({ answered: true, answer: "late private answer", sources: [] })),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
  expect(el.textContent?.trim()).toBe("");
});
