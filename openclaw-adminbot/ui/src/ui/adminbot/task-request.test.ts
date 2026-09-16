import { afterEach, describe, expect, it, vi } from "vitest";
import { taskActivities, taskFetch } from "./task-request.ts";
import { AdminBotTaskStatus } from "./views/task-status.ts";

// Bind the fixture to this evaluation's registry rather than a cached production tag.
class RequestTaskStatus extends AdminBotTaskStatus {}
customElements.define("test-request-task-status", RequestTaskStatus);

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const task = (status: string, actions: string[]) =>
  json({ task: { id: "task-1", status, actions } }, 202);
async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}
afterEach(() => {
  for (const item of taskActivities.values()) item.detach();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("application task requests", () => {
  it("Wait delivers the original final result with no resubmission", async () => {
    sessionStorage.setItem("adminbot-visitor:http://localhost:8765", "existing-visitor");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(task("shed", ["wait", "cancel"]))
      .mockResolvedValueOnce(task("completed", ["result"]))
      .mockResolvedValueOnce(json({ assistant_message: "Receipt ready", ready: true }));
    vi.stubGlobal("fetch", fetcher);
    const pending = taskFetch("http://localhost:8765/reimbursements/converse", {
      method: "POST",
      body: '{"message":"synthetic"}',
    });
    await until(() => taskActivities.values().next().value?.task?.status === "shed");
    taskActivities.values().next().value!.act("wait");
    expect(await (await pending).json()).toEqual({
      assistant_message: "Receipt ready",
      ready: true,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8765/reimbursements/converse",
      "http://localhost:8765/tasks/task-1/wait",
      "http://localhost:8765/tasks/task-1/result",
    ]);
    expect(fetcher.mock.calls.every(([, init]) => init.credentials === "include")).toBe(true);
    expect(taskActivities.size).toBe(0);
  });

  it("reconnects a lost submission using the same identity", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json({ answer: "done" }));
    vi.stubGlobal("fetch", fetcher);
    const pending = taskFetch("http://localhost:8765/lab-sharing/ask", {
      method: "POST",
      body: '{"question":"hello"}',
    });
    await until(() => Boolean(taskActivities.values().next().value?.message));
    taskActivities.values().next().value!.act("status");
    expect(await (await pending).json()).toEqual({ answer: "done" });
    const keys = fetcher.mock.calls.map(([, init]) => init.headers.get("Idempotency-Key"));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("detaches when destroyed and reconnects the retained handle", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(task("needs_retry", ["retry", "cancel"]))
      .mockResolvedValueOnce(task("completed", ["result"]))
      .mockResolvedValueOnce(json({ answer: "recovered" }));
    vi.stubGlobal("fetch", fetcher);
    const element = new RequestTaskStatus();
    document.body.append(element);
    const options = { method: "POST", body: '{"question":"resume"}' };
    const pending = taskFetch("http://localhost:8765/lab-sharing/ask", options);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await until(() => taskActivities.values().next().value?.task?.status === "needs_retry");
    await element.updateComplete;
    expect(element.textContent).toContain("Retry uncertain step");
    expect(element.textContent).toContain("Cancel");
    element.remove();
    await rejected;
    expect(taskActivities.size).toBe(0);
    const result = await taskFetch("http://localhost:8765/lab-sharing/ask", options);
    expect(await result.json()).toEqual({ answer: "recovered" });
    expect(fetcher.mock.calls[1][0]).toBe("http://localhost:8765/tasks/task-1");
  });

  it("stops queued polling after the caller disconnects", async () => {
    const fetcher = vi.fn().mockResolvedValue(task("queued", ["cancel"]));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const pending = taskFetch("http://localhost:8765/cv/scan", {
      method: "POST",
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await until(() => taskActivities.values().next().value?.task?.status === "queued");
    controller.abort();
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(taskActivities.size).toBe(0);
  });

  it("retains the visitor fallback only for anonymous tasks", async () => {
    const bootstrap = json({ visitor: { ready: true } });
    bootstrap.headers.set("X-AdminBot-Visitor", "synthetic-visitor-token");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(bootstrap)
      .mockResolvedValueOnce(task("shed", ["wait"]))
      .mockResolvedValueOnce(task("completed", ["result"]))
      .mockResolvedValueOnce(json({ ready: true }))
      .mockResolvedValueOnce(json({ answered: true }));
    vi.stubGlobal("fetch", fetcher);
    const pending = taskFetch("http://localhost:8765/reimbursements/converse", { method: "POST" });
    await until(() => taskActivities.values().next().value?.task?.status === "shed");
    taskActivities.values().next().value!.act("wait");
    await pending;
    expect(sessionStorage.getItem("adminbot-visitor:http://localhost:8765")).toBe(
      "synthetic-visitor-token",
    );
    expect(fetcher.mock.calls[1][1].headers.get("X-AdminBot-Visitor")).toBe(
      "synthetic-visitor-token",
    );
    await taskFetch("http://localhost:8765/lab-sharing/ask", {
      method: "POST",
      headers: { Authorization: "Bearer member" },
    });
    expect(fetcher.mock.calls[4][1].headers.has("X-AdminBot-Visitor")).toBe(false);
  });

  it.each([200, 202])(
    "retains submission identity after a truncated %i response",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response('{"task":', { status }))
        .mockResolvedValueOnce(task("shed", ["wait"]))
        .mockResolvedValueOnce(task("completed", ["result"]))
        .mockResolvedValueOnce(json({ answer: "Recovered" }));
      vi.stubGlobal("fetch", fetcher);
      const pending = taskFetch("http://localhost:8765/lab-sharing/ask", {
        method: "POST",
        body: "{}",
      });
      await until(() =>
        Boolean(taskActivities.values().next().value?.message?.includes("incomplete")),
      );
      const identity = fetcher.mock.calls[0][1].headers.get("Idempotency-Key");
      expect(
        Object.keys(sessionStorage).some((key) => sessionStorage.getItem(key)?.includes(identity)),
      ).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      taskActivities.values().next().value!.act("status");
      await until(() => taskActivities.values().next().value?.task?.status === "shed");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1][1].headers.get("Idempotency-Key")).toBe(identity);
      taskActivities.values().next().value!.act("wait");
      expect(await (await pending).json()).toEqual({ answer: "Recovered" });
    },
  );

  it("establishes the visitor before a lost first submission and reuses both identities", async () => {
    const bootstrap = json({ visitor: { ready: true } });
    bootstrap.headers.set("X-AdminBot-Visitor", "stable-visitor");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(bootstrap)
      .mockRejectedValueOnce(new TypeError("response lost before headers"))
      .mockResolvedValueOnce(json({ assistant_message: "Same turn completed" }));
    vi.stubGlobal("fetch", fetcher);
    const pending = taskFetch("http://localhost:8765/reimbursements/converse", {
      method: "POST",
      body: "{}",
    });
    await until(() => Boolean(taskActivities.values().next().value?.message));
    expect(fetcher.mock.calls[0][0]).toBe("http://localhost:8765/tasks/visitor");
    expect(sessionStorage.getItem("adminbot-visitor:http://localhost:8765")).toBe("stable-visitor");
    taskActivities.values().next().value!.act("status");
    expect(await (await pending).json()).toEqual({ assistant_message: "Same turn completed" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const first = fetcher.mock.calls[1][1].headers;
    const retried = fetcher.mock.calls[2][1].headers;
    expect(retried.get("X-AdminBot-Visitor")).toBe("stable-visitor");
    expect(retried.get("Idempotency-Key")).toBe(first.get("Idempotency-Key"));
  });

  it("cancel and expiry are errors rather than successful empty workflow results", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(task("shed", ["cancel"]))
      .mockResolvedValueOnce(task("cancelled", []));
    vi.stubGlobal("fetch", fetcher);
    const pending = taskFetch("http://localhost:8765/lab-sharing/ask", { method: "POST" });
    await until(() => taskActivities.values().next().value?.task?.status === "shed");
    taskActivities.values().next().value!.act("cancel");
    const result = await pending;
    expect(result.ok).toBe(false);
    expect((await result.json()).error.message).toContain("cancelled");
    fetcher.mockResolvedValueOnce(json({ error: { message: "Task expired" } }, 410));
    expect(
      (await taskFetch("http://localhost:8765/lab-sharing/ask", { method: "POST" })).status,
    ).toBe(410);
  });
});
