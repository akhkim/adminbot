import { afterEach, expect, it, vi } from "vitest";
import { taskActivities } from "./task-request.ts";
import { AdminBotTaskStatus } from "./views/task-status.ts";

// A unique subclass avoids stale production registrations in the isolate:false UI lane.
class RecoveredTaskStatus extends AdminBotTaskStatus {}
customElements.define("test-recovered-task-status", RecoveredTaskStatus);

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const completed = {
  id: "saved-task",
  kind: "member-guidebook",
  status: "completed",
  actions: ["result"],
};
afterEach(() => {
  document.body.replaceChildren();
  taskActivities.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("restores a completed task on reload and lets its owner retrieve the final answer", async () => {
  sessionStorage.setItem(
    "adminbot-task:synthetic-saved-key",
    JSON.stringify({ submission: "original", id: "saved-task" }),
  );
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ tasks: [completed] }))
    .mockResolvedValueOnce(json({ task: completed }))
    .mockResolvedValueOnce(
      json({ answered: true, answer: "Use the recordings guide.", sources: ["Recordings"] }),
    );
  vi.stubGlobal("fetch", fetcher);
  const element = new RecoveredTaskStatus();
  element.baseUrl = "http://localhost:8765";
  element.sessionContext = "member-a";
  document.body.append(element);
  await vi.waitFor(() => expect(element.textContent).toContain("View result"));
  expect(fetcher.mock.calls[0][0]).toBe("http://localhost:8765/tasks");
  element.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(element.textContent).toContain("Use the recordings guide."));
  expect(element.querySelector("a")?.textContent).toContain("Download result");
  expect(
    fetcher.mock.calls.every(
      ([, options]) => new Headers(options.headers).get("Authorization") === "Bearer member-a",
    ),
  ).toBe(true);
});

it("clears previous owner results on account switch and rejects late listing responses after logout", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ tasks: [completed] }))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(json({ tasks: [] }));
  vi.stubGlobal("fetch", fetcher);
  const element = new RecoveredTaskStatus();
  element.baseUrl = "http://localhost:8765";
  element.sessionContext = "member-a";
  document.body.append(element);
  await vi.waitFor(() => expect(element.textContent).toContain("View result"));
  element.sessionContext = "member-b";
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(element.textContent).not.toContain("View result");
  element.sessionContext = "visitor";
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  finish(json({ tasks: [completed] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
  expect(element.textContent).not.toContain("View result");
  expect(new Headers(fetcher.mock.calls[2][1].headers).has("Authorization")).toBe(false);
});

it("restores visitor tasks using only the isolated service visitor token", async () => {
  sessionStorage.setItem("adminbot-visitor:http://localhost:8765", "synthetic-visitor");
  const fetcher = vi
    .fn()
    .mockResolvedValue(json({ tasks: [{ ...completed, kind: "reimbursement" }] }));
  vi.stubGlobal("fetch", fetcher);
  const element = new RecoveredTaskStatus();
  element.baseUrl = "http://localhost:8765";
  element.sessionContext = "visitor";
  document.body.append(element);
  await vi.waitFor(() => expect(element.textContent).toContain("Reimbursement"));
  const headers = new Headers(fetcher.mock.calls[0][1].headers);
  expect(headers.get("X-AdminBot-Visitor")).toBe("synthetic-visitor");
  expect(headers.has("Authorization")).toBe(false);
});

it("continues a restored queued task into its final application result", async () => {
  const queued = { ...completed, status: "queued", actions: ["cancel"] };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ tasks: [queued] }))
    .mockResolvedValueOnce(json({ task: completed }))
    .mockResolvedValueOnce(json({ answered: true, answer: "Recovered final answer" }));
  vi.stubGlobal("fetch", fetcher);
  const element = new RecoveredTaskStatus();
  element.baseUrl = "http://localhost:8765";
  element.sessionContext = "member-a";
  document.body.append(element);
  await vi.waitFor(() => expect(element.textContent).toContain("Recovered final answer"));
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "http://localhost:8765/tasks",
    "http://localhost:8765/tasks/saved-task",
    "http://localhost:8765/tasks/saved-task/result",
  ]);
});

it("offers the wait preference on a recovered shed task with bearer-only history", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (url) =>
      String(url).endsWith("/tasks")
        ? json({ tasks: [{ ...completed, status: "shed", actions: ["wait", "cancel"] }] })
        : json({ inference_always_wait: false }),
    );
  vi.stubGlobal("fetch", fetcher);
  const element = new RecoveredTaskStatus();
  element.baseUrl = "http://localhost:8765";
  element.sessionContext = "member-a";
  document.body.append(element);
  await vi.waitFor(() =>
    expect(
      element.querySelector('[aria-label="Recovered task"] adminbot-wait-preference'),
    ).not.toBeNull(),
  );
  expect(fetcher.mock.calls[0][1].credentials).toBe("omit");
});

it("removes a recovered task after cancellation without relabeling it as failed", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (url) =>
      String(url).endsWith("/tasks")
        ? json({ tasks: [{ ...completed, status: "shed", actions: ["cancel"] }] })
        : String(url).endsWith("/cancel")
          ? json({ task: { ...completed, status: "cancelled", actions: [] } })
          : json({ inference_always_wait: false }),
    );
  vi.stubGlobal("fetch", fetcher);
  const element = new RecoveredTaskStatus();
  element.baseUrl = "http://localhost:8765";
  element.sessionContext = "member-a";
  document.body.append(element);
  await vi.waitFor(() => expect(element.textContent).toContain("Cancel"));
  element.querySelector<HTMLButtonElement>('[aria-label="Recovered task"] button')!.click();
  await vi.waitFor(() => expect(element.querySelector('[aria-label="Recovered task"]')).toBeNull());
  expect(element.textContent).not.toContain("could not finish");
});

it("shows the server's rejection reason when a recovered task response includes its handle", async () => {
  const reason =
    "Task execution attempt limit exceeded; review the outcome before submitting a new task";
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({ tasks: [{ ...completed, status: "failed", actions: ["retry"] }] }),
    )
    .mockResolvedValueOnce(
      json(
        { task: { ...completed, status: "failed", actions: [] }, error: { message: reason } },
        409,
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const element = new RecoveredTaskStatus();
  element.baseUrl = "http://localhost:8765";
  element.sessionContext = "member-a";
  document.body.append(element);
  await vi.waitFor(() => expect(element.textContent).toContain("Resume"));
  element.querySelector<HTMLButtonElement>('[aria-label="Recovered task"] button')!.click();
  await vi.waitFor(() =>
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(reason),
  );
  expect(element.textContent).not.toContain("Resume");
});
