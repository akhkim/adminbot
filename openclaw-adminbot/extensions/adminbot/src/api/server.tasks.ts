import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskRuntime, TaskSubmission } from "../tasks/runtime.js";
import type { TaskRecord } from "../tasks/store.js";
import { sendJson } from "./server.http.js";
import { inferenceCallContext } from "./server.inference.js";

export function taskView(task: TaskRecord, requestError?: string) {
  const actions: string[] = [];
  if (task.status === "shed") {
    actions.push("wait");
  }
  if (["shed", "queued", "running"].includes(task.status)) {
    actions.push("cancel");
  }
  if ((task.status === "needs_retry" || task.status === "failed") && !task.retryExhausted) {
    actions.push("retry");
  }
  if (task.status === "completed") {
    actions.push("result");
  }
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    error: task.error,
    ...(requestError ? { requestError } : {}),
    actions,
  };
}

function statusCode(task: TaskRecord): number {
  if (task.status === "completed" || task.status === "cancelled") {
    return 200;
  }
  if (task.status === "expired") {
    return 410;
  }
  if (task.status === "failed") {
    return 502;
  }
  if (task.status === "shed" || task.status === "needs_retry") {
    return 409;
  }
  return 202;
}

function sendTask(res: ServerResponse, task: TaskRecord, runtime: TaskRuntime) {
  const message =
    task.error ??
    (task.status === "shed"
      ? "Task saved. Choose Wait to run it."
      : `Task ${task.status.replaceAll("_", " ")}.`);
  sendJson(res, statusCode(task), {
    task: taskView(task, runtime.requestError(task)),
    ...(task.status === "completed" ? {} : { error: { message } }),
  });
}

/** A short response window does not own execution: disconnects leave the service task intact. */
export async function submitHttpTask(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: TaskRuntime,
  owner: string,
  kind: string,
  input: unknown,
  alwaysWait = false,
) {
  const context = inferenceCallContext(req, owner);
  let submission: TaskSubmission;
  try {
    submission = runtime.submit({
      owner,
      kind,
      input,
      key: context.submissionKey,
      wait: context.wait ?? alwaysWait,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, /conflict|identity|different/iu.test(message) ? 409 : 503, {
      error: { message },
    });
    return;
  }
  let task = submission.task;
  if (submission.promise) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    task = await Promise.race([
      submission.promise,
      new Promise<TaskRecord>((resolve) => {
        timer = setTimeout(() => resolve(runtime.get(submission.id, owner) ?? task), 150);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
  }
  if (task.status === "completed") {
    sendJson(res, 200, task.result);
  } else {
    sendTask(res, task, runtime);
  }
}

export async function handleTaskRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: TaskRuntime,
  owner: string,
  mayRead: (task: TaskRecord) => boolean,
  mayManageShared: (task: TaskRecord) => boolean = () => false,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/tasks") {
    sendJson(res, 200, {
      tasks: runtime
        .list()
        .filter((task) => task.owner === owner || mayManageShared(task))
        .filter(mayRead)
        .map((task) => taskView(task, runtime.requestError(task))),
    });
    return true;
  }
  const match = /^\/tasks\/([^/]+)(?:\/(result|wait|cancel|retry))?$/u.exec(url.pathname);
  if (!match?.[1]) {
    return false;
  }
  const task = runtime.get(decodeURIComponent(match[1]));
  if (!task || (task.owner !== owner && !mayManageShared(task)) || !mayRead(task)) {
    sendJson(res, 404, { error: { message: "no such task" } });
    return true;
  }
  const action = match[2];
  if (req.method === "GET" && !action) {
    sendJson(res, 200, { task: taskView(task, runtime.requestError(task)) });
    return true;
  }
  if (req.method === "GET" && action === "result") {
    if (task.status === "completed") {
      sendJson(res, 200, task.result);
    } else {
      sendTask(res, task, runtime);
    }
    return true;
  }
  if (req.method === "POST" && (action === "wait" || action === "retry" || action === "cancel")) {
    try {
      if (action === "cancel") {
        runtime.cancel(task.id, task.owner);
      } else if (action === "wait") {
        runtime.wait(task.id, task.owner);
      } else {
        runtime.retry(task.id, task.owner);
      }
      sendTask(res, runtime.get(task.id, task.owner) ?? task, runtime);
    } catch (error) {
      const current = runtime.get(task.id, task.owner) ?? task;
      sendJson(res, 409, {
        task: taskView(current, runtime.requestError(current)),
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    return true;
  }
  return false;
}
