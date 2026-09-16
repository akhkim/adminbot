/** Deferred application tasks keep their original caller alive until the final domain result. */
export type TaskHandle = {
  id: string;
  status: string;
  kind?: string;
  /** Submission time, so a member's tasks number in the order they sent them. */
  createdAt?: string | number;
  expiresAt?: string | number;
  actions: string[];
  requestError?: string;
  error?: string;
};
export type TaskActivity = {
  key: string;
  label: string;
  task?: TaskHandle;
  message?: string;
  requestError?: string;
  act: (action: string) => void;
  detach: () => void;
};
export const taskActivities = new Map<string, TaskActivity>();
export const taskChanges = new EventTarget();
const notify = () => taskChanges.dispatchEvent(new Event("change"));
const storagePrefix = "adminbot-task:";
const inFlight = new Map<string, Promise<Response>>();
const visitorBootstraps = new Map<string, Promise<string>>();
async function bootstrapVisitor(base: string): Promise<string> {
  const existing = visitorBootstraps.get(base);
  if (existing) {
    return existing;
  }
  // Establish the owner before creating work. A lost bootstrap response can create another
  // empty visitor, whereas losing the first task response must never change its owner.
  const pending = (async () => {
    const response = await fetch(`${base}/tasks/visitor`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const token = response.headers.get("X-AdminBot-Visitor");
    if (!response.ok || !token) {
      throw new Error("Visitor session could not be established.");
    }
    try {
      sessionStorage.setItem(`adminbot-visitor:${base}`, token);
    } catch {
      /* The current request still retains its credential. */
    }
    return token;
  })();
  visitorBootstraps.set(base, pending);
  try {
    return await pending;
  } finally {
    visitorBootstraps.delete(base);
  }
}

export function isTaskPath(path: string): boolean {
  return (
    /^\/cv\/blurb\/[^/]+$/u.test(path) ||
    [
      "/reimbursements/converse",
      "/lab-sharing/ask",
      "/guidebook/ask",
      "/papers/import/columns",
      "/cv/scan",
      "/privacy/tasks",
    ].includes(path)
  );
}
type SubmissionIdentity = { submission: string; id?: string; unconfirmed?: boolean };
function stored(key: string): SubmissionIdentity {
  try {
    const value = sessionStorage.getItem(storagePrefix + key);
    if (value) {
      const identity = JSON.parse(value) as SubmissionIdentity;
      // Older saved handles did not record whether a submission response was lost.
      return { ...identity, unconfirmed: identity.unconfirmed ?? !identity.id };
    }
  } catch {
    /* Storage can be disabled; the live request still retains identity. */
  }
  return { submission: crypto.randomUUID(), unconfirmed: false };
}
function save(key: string, value?: SubmissionIdentity) {
  try {
    if (value) {
      // Bound stale reconnect handles; accepted server tasks have their own retention policy.
      const keys = Object.keys(sessionStorage).filter((item) => item.startsWith(storagePrefix));
      if (keys.length >= 32 && !keys.includes(storagePrefix + key)) {
        sessionStorage.removeItem(keys[0]);
      }
      sessionStorage.setItem(storagePrefix + key, JSON.stringify(value));
    } else {
      sessionStorage.removeItem(storagePrefix + key);
    }
  } catch {
    /* No request content or credentials are persisted. */
  }
}
function taskBase(url: string): string {
  const path = new URL(url, location.href).pathname;
  const endpoint =
    path.match(/\/tasks\/[^/]+(?:\/(?:retry|wait|cancel))?$/u)?.[0] ??
    path.match(/\/cv\/blurb\/[^/]+$/u)?.[0] ??
    [
      "/reimbursements/converse",
      "/lab-sharing/ask",
      "/guidebook/ask",
      "/papers/import/columns",
      "/cv/scan",
      "/privacy/tasks",
    ].find((item) => path.endsWith(item));
  return url.slice(0, -(endpoint?.length ?? path.length));
}
export async function taskFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const path = new URL(url, location.href).pathname;
  const base = taskBase(url);
  const anonymous =
    !headers.has("Authorization") &&
    (path.endsWith("/reimbursements/converse") || /\/tasks\//u.test(path));
  init.signal?.throwIfAborted();
  if (anonymous && !headers.has("X-AdminBot-Visitor")) {
    try {
      const token = sessionStorage.getItem(`adminbot-visitor:${base}`);
      if (token) {
        headers.set("X-AdminBot-Visitor", token);
      }
    } catch {
      /* Bootstrap can recover a same-origin cookie. */
    }
    if (!headers.has("X-AdminBot-Visitor") && path.endsWith("/reimbursements/converse")) {
      headers.set("X-AdminBot-Visitor", await bootstrapVisitor(base));
    }
  }
  init.signal?.throwIfAborted();
  // Hash the identity scope too: a different signed-in member must never inherit this handle.
  const bytes = new TextEncoder().encode(
    `${url}\n${init.method ?? "GET"}\n${headers.get("Authorization") ?? headers.get("X-AdminBot-Visitor") ?? "visitor"}\n${init.body ?? ""}`,
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const key = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  const existing = inFlight.get(key);
  if (existing) {
    return (await existing).clone();
  }
  const promise = runTask(url, init, headers, key);
  inFlight.set(key, promise);
  try {
    return (await promise).clone();
  } finally {
    inFlight.delete(key);
  }
}
async function runTask(
  url: string,
  init: RequestInit,
  headers: Headers,
  key: string,
): Promise<Response> {
  const identity = stored(key);
  save(key, identity);
  headers.set("Idempotency-Key", identity.submission);
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) {
    abort();
  }
  let wake: ((action: string) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const activity: TaskActivity = {
    key,
    label: new URL(url, location.href).pathname,
    act: (action) => wake?.(action),
    detach: abort,
  };
  const options = {
    headers,
    credentials: init.credentials ?? (headers.has("Authorization") ? "omit" : "include"),
    signal: controller.signal,
  };
  const path = new URL(url, location.href).pathname;
  const base = taskBase(url);
  const explicitTask = path.match(/\/tasks\/([^/]+)(?:\/(retry|wait|cancel))?$/u);
  if (explicitTask) {
    identity.id = decodeURIComponent(explicitTask[1]);
    save(key, identity);
  }
  const visitorKey = `adminbot-visitor:${base}`;
  const anonymous =
    !headers.has("Authorization") &&
    (path.endsWith("/reimbursements/converse") || /\/tasks\//u.test(path));
  const taskUrl = () => `${base}/tasks/${encodeURIComponent(identity.id!)}`;
  const wait = (delay?: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const done = (action: string) => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", cancelled);
        wake = undefined;
        resolve(action);
      };
      const cancelled = () => {
        clearTimeout(timer);
        wake = undefined;
        reject(new DOMException("Task detached", "AbortError"));
      };
      if (controller.signal.aborted) {
        cancelled();
        return;
      }
      controller.signal.addEventListener("abort", cancelled, { once: true });
      wake = done;
      if (delay !== undefined) {
        timer = setTimeout(() => done("status"), delay);
      }
    });
  taskActivities.set(key, activity);
  notify();
  try {
    let action = explicitTask ? (explicitTask[2] ?? "status") : identity.id ? "status" : "submit";
    while (true) {
      let response: Response;
      const priorSubmissionUnconfirmed = identity.unconfirmed;
      try {
        controller.signal.throwIfAborted();
        if (action === "submit") {
          // A later 401 must distinguish a rejected first submission from a lost response
          // to work that could already exist, including after the browser reloads.
          identity.unconfirmed = true;
          save(key, identity);
        }
        response =
          action === "submit"
            ? await fetch(url, { ...init, ...options })
            : await fetch(`${taskUrl()}${action === "status" ? "" : `/${action}`}`, {
                ...options,
                method: action === "status" || action === "result" ? "GET" : "POST",
              });
      } catch (error) {
        if (controller.signal.aborted) {
          throw error;
        }
        activity.message =
          "Connection lost. Reconnect to the same task; your request will not be submitted twice.";
        notify();
        await wait();
        action = identity.id ? "status" : "submit";
        continue;
      }
      if (anonymous && response.status === 401) {
        save(key);
        try {
          if (sessionStorage.getItem(visitorKey) === headers.get("X-AdminBot-Visitor")) {
            sessionStorage.removeItem(visitorKey);
          }
        } catch {
          /* The error still requires an explicit new submission. */
        }
        return new Response(
          JSON.stringify({
            error: {
              message: identity.id
                ? "Your visitor session expired. The previous request can no longer be retrieved and may already have run. Review its outcome before submitting a new request."
                : priorSubmissionUnconfirmed
                  ? "Your visitor session expired. An earlier submission may already have run, but its outcome cannot be checked with this session. Review its outcome before submitting a new request."
                  : "Your visitor session expired. This submission was not accepted. Submit again to start a new visitor session.",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      if (anonymous) {
        const token = response.headers.get("X-AdminBot-Visitor");
        if (token) {
          headers.set("X-AdminBot-Visitor", token);
          try {
            sessionStorage.setItem(visitorKey, token);
          } catch {
            /* Cookie remains available. */
          }
        }
      }
      controller.signal.throwIfAborted();
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch (error) {
        if (controller.signal.aborted) {
          throw error;
        }
        if (response.ok) {
          // A partial response says nothing about whether the server accepted or finished work.
          // Keep both submission and owner identities until a complete response is retrieved.
          activity.message =
            "Connection lost. The response was incomplete. Reconnect to retrieve the same task.";
          notify();
          await wait();
          action = identity.id ? "status" : "submit";
          continue;
        }
        body = null;
      }
      controller.signal.throwIfAborted();
      const envelope = body as { task?: TaskHandle; error?: { message?: string } } | null;
      const task = envelope?.task;
      if (!task || typeof task.id !== "string") {
        if (
          action === "submit" &&
          response.status >= 400 &&
          response.status < 500 &&
          typeof envelope?.error?.message === "string" &&
          !priorSubmissionUnconfirmed
        ) {
          identity.unconfirmed = false;
          save(key, identity);
        }
        if (identity.id && (response.status === 429 || response.status >= 500)) {
          activity.requestError =
            envelope?.error?.message ?? "The service could not retrieve this request. Try again.";
          notify();
          action = await wait();
          continue;
        }
        if (response.ok || response.status === 404 || response.status === 410) {
          save(key);
        }
        return response;
      }
      identity.id = task.id;
      identity.unconfirmed = false;
      save(key, identity);
      activity.task = { ...task, actions: Array.isArray(task.actions) ? task.actions : [] };
      activity.message = envelope?.error?.message ?? task.error;
      activity.requestError =
        task.requestError ??
        (["failed", "needs_retry"].includes(task.status) ? activity.message : undefined);
      notify();
      if (task.status === "completed") {
        action = "result";
        continue;
      }
      if (
        ["cancelled", "expired", "unsupported", "interrupted"].includes(task.status) ||
        (["failed", "needs_retry"].includes(task.status) &&
          !activity.task.actions.includes("retry"))
      ) {
        save(key);
        return new Response(
          JSON.stringify({
            task: activity.task,
            error: { message: activity.message || `Task ${task.status}.` },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      const expiry = task.expiresAt ? new Date(task.expiresAt).getTime() : Number.NaN;
      if (Number.isFinite(expiry) && expiry <= Date.now()) {
        save(key);
        return new Response(
          JSON.stringify({ error: { message: "Task expired. Submit a new request." } }),
          { status: 410 },
        );
      }
      const pending = ["pending", "queued", "running", "accepted"].includes(task.status);
      action = await wait(
        pending ? 1500 : Number.isFinite(expiry) ? Math.max(1, expiry - Date.now()) : undefined,
      );
    }
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
    taskActivities.delete(key);
    notify();
  }
}
