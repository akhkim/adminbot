import type { TaskHandle } from "./task-request.ts";

export type RecoveredTask = { task: TaskHandle; result?: unknown; error?: string; busy?: boolean };
export async function listRecentTasks(
  baseUrl: string,
  token: string,
  signal: AbortSignal,
): Promise<TaskHandle[]> {
  const headers = new Headers({ Accept: "application/json" });
  if (token && token !== "visitor") {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    try {
      const visitor = sessionStorage.getItem(`adminbot-visitor:${baseUrl}`);
      if (visitor) {
        headers.set("X-AdminBot-Visitor", visitor);
      }
    } catch {
      /* Same-origin cookies can still identify this visitor. */
    }
  }
  const response = await fetch(`${baseUrl}/tasks`, { headers, credentials: "include", signal });
  if (response.status === 401 || response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error("Recent tasks could not be loaded.");
  }
  const body = await response.json();
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  return tasks
    .filter((task: TaskHandle) => typeof task?.id === "string" && typeof task.status === "string")
    .toSorted(
      (a: TaskHandle & { createdAt?: string }, b: TaskHandle & { createdAt?: string }) =>
        new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
    )
    .slice(0, 12);
}

/** These are final endpoint results, never model checkpoints, prompts, or diagnostic records. */
export function applicationResultSummary(result: unknown): string {
  if (!result || typeof result !== "object") {
    return typeof result === "string" ? result : "Task completed.";
  }
  const value = result as Record<string, unknown>;
  for (const key of ["assistant_message", "answer", "blurb", "output", "response", "text"]) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  const scan =
    value.result && typeof value.result === "object"
      ? (value.result as Record<string, unknown>)
      : value;
  if (Array.isArray(scan.results)) {
    const failed = scan.results.filter((entry) => entry?.status === "failed").length;
    const skipped = scan.results.filter((entry) => entry?.status === "skipped").length;
    return `${scan.results.length} CV records checked; ${failed} failed, ${skipped} skipped. Download the result to review each member's changes.`;
  }
  if (value.mapping && typeof value.mapping === "object") {
    return Object.entries(value.mapping)
      .map(([from, to]) => `${from} → ${String(to)}`)
      .join("\n");
  }
  if (Array.isArray(value.recipients)) {
    return `${value.recipients.length} recipient recommendations are ready for review. Download the result for details.`;
  }
  return "The final application result is ready. Download it to review the complete result.";
}
