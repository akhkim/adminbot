import { AsyncLocalStorage } from "node:async_hooks";

export type TaskStepOptions = { timeoutMs?: number; replaySafe?: boolean };
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
