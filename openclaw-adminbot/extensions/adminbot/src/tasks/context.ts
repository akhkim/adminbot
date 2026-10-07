import { AsyncLocalStorage } from "node:async_hooks";

export type TaskStepOptions = { timeoutMs?: number; replaySafe?: boolean };
/**
 * Thrown from a step body when the attempt definitely finished and failed, with no effect that an
 * explicit retry would have to reconcile -- a model call that answered 503, timed out or never
 * connected. The runtime records the step as failed rather than uncertain and rethrows `cause`, so
 * a caller that tolerates one failed item can carry on. A later attempt at the same key runs again.
 */
export class TaskStepFailedError extends Error {
  override name = "TaskStepFailedError";
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
export type TaskContext = {
  id: string;
  owner: string;
  signal: AbortSignal;
  check(): void;
  progress(value: Record<string, unknown>): void;
  step<T>(
    key: string,
    input: unknown,
    fn: () => T | Promise<T>,
    options?: TaskStepOptions,
  ): Promise<T>;
  commit<T>(key: string, input: unknown, fn: () => T): T;
};
export const taskStepAttemptStorage = new AsyncLocalStorage<string>();
export function currentTaskStepAttempt(): string | undefined {
  return taskStepAttemptStorage.getStore();
}
export const taskContextStorage = new AsyncLocalStorage<TaskContext>();
export function currentTaskContext(): TaskContext | undefined {
  return taskContextStorage.getStore();
}
export function taskStep<T>(
  key: string,
  input: unknown,
  fn: () => T | Promise<T>,
  options?: TaskStepOptions,
): Promise<T> {
  const ctx = currentTaskContext();
  return ctx ? ctx.step(key, input, fn, options) : Promise.resolve().then(fn);
}

const taskScopeStorage = new AsyncLocalStorage<string>();
export function currentTaskScope(): string {
  return taskScopeStorage.getStore() ?? "";
}
export function withTaskScope<T>(scope: string, fn: () => T): T {
  const parent = currentTaskScope();
  return taskScopeStorage.run(parent ? `${parent}/${scope}` : scope, fn);
}
