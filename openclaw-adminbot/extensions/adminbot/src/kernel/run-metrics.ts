// Counters for one request's worth of work, so an automation run can say what it did.
//
// A sweep endpoint (the paperflow nudges, the escalation pass, the slot reminders) is called by a
// cron script with the service token. The usage recorder opens a bag around each request; code deep
// in the service bumps a named counter in it without the route having to thread anything through.
// Outside a request, a test or a timer, `countRunMetric` is a no-op.
//
// Names are short dotted identifiers (`nudges_sent.paperflow`), values are non-negative integers.
// Nothing here may carry a person's name, an address or message text.
import { AsyncLocalStorage } from "node:async_hooks";

export type RunMetrics = Record<string, number>;

const bags = new AsyncLocalStorage<Map<string, number>>();

export const RUN_METRIC_NAME = /^[a-z][a-z0-9_.:-]{0,63}$/u;
/** A run that names more counters than this is not counting anything a person reads. */
export const RUN_METRIC_LIMIT = 40;

/** Run `work` with its own bag, and hand back the bag so the caller can read it when it is done. */
export function withRunMetrics<T>(work: () => T): { result: T; metrics: () => RunMetrics } {
  const bag = new Map<string, number>();
  const result = bags.run(bag, work);
  return { result, metrics: () => Object.fromEntries(bag) };
}

export function countRunMetric(name: string, by = 1): void {
  const bag = bags.getStore();
  if (!bag || !RUN_METRIC_NAME.test(name) || !Number.isInteger(by) || by <= 0) {
    return;
  }
  if (!bag.has(name) && bag.size >= RUN_METRIC_LIMIT) {
    return;
  }
  bag.set(name, (bag.get(name) ?? 0) + by);
}

/**
 * The counters a caller sent, with anything that is not a counter dropped: an unknown shape, a
 * name outside the pattern, a negative or fractional value. Returns undefined when nothing is left.
 */
export function cleanRunMetrics(raw: unknown): RunMetrics | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: RunMetrics = {};
  let count = 0;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= RUN_METRIC_LIMIT) {
      break;
    }
    if (!RUN_METRIC_NAME.test(name) || typeof value !== "number") {
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      continue;
    }
    out[name] = value;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/**
 * A nudge ledger write that is a send, counted as `nudges_sent.<domain>`. The ledger is written on
 * every send with the count raised by one, and on a snooze with the count left alone, so a raised
 * count is the one sign a message went out.
 */
export function countNudgeLedgerWrite(
  previousCount: number | undefined,
  record: { domain: string; nudge_count: number },
): void {
  if (record.nudge_count > (previousCount ?? 0)) {
    countRunMetric(`nudges_sent.${record.domain}`);
  }
}
