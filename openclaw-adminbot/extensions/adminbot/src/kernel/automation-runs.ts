import type { AdminBotAuditEvent } from "../contracts/actions.js";
// What the scheduled automation did, per job, from records AdminBot already keeps.
//
// Two sources, neither new: the cron heartbeats every job posts (scripts/lib/adminbot-cron-run.sh,
// now with the run's duration and counters), and the service-token rows of the API usage log, which
// carry what the sweep endpoints counted while they ran (nudges sent per domain and so on).
import type { AdminBotAutomationSweep } from "../contracts/api-usage.js";

export type AutomationRunTotals = {
  runs: number;
  failures: number;
  avg_ms?: number;
  max_ms?: number;
  last_at?: string;
  last_ok_at?: string;
  /** Summed over the window, for the counters the runs reported. */
  metrics: Record<string, number>;
};

export type AutomationRunReport = {
  from: string;
  days: number;
  /** One row per cron job, from its heartbeats. */
  jobs: Array<AutomationRunTotals & { job: string }>;
  /** One row per sweep endpoint the cron scripts call with the service token. */
  sweeps: AdminBotAutomationSweep[];
};

type Tally = AutomationRunTotals & { timed: number; total_ms: number };

function tally(): Tally {
  return { runs: 0, failures: 0, metrics: {}, timed: 0, total_ms: 0 };
}

function note(
  into: Tally,
  run: { at: string; ok: boolean; duration_ms?: number; metrics?: Record<string, number> },
): void {
  into.runs += 1;
  if (!run.ok) {
    into.failures += 1;
  }
  if (!into.last_at || run.at > into.last_at) {
    into.last_at = run.at;
  }
  if (run.ok && (!into.last_ok_at || run.at > into.last_ok_at)) {
    into.last_ok_at = run.at;
  }
  if (typeof run.duration_ms === "number") {
    into.timed += 1;
    into.total_ms += run.duration_ms;
    into.max_ms = Math.max(into.max_ms ?? 0, run.duration_ms);
  }
  for (const [name, value] of Object.entries(run.metrics ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      into.metrics[name] = (into.metrics[name] ?? 0) + value;
    }
  }
}

function finish(value: Tally): AutomationRunTotals {
  const { timed, total_ms, ...rest } = value;
  return { ...rest, ...(timed ? { avg_ms: Math.round(total_ms / timed) } : {}) };
}

function numericRecord(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[name] = value;
    }
  }
  return out;
}

export function automationRunReport(input: {
  events: readonly AdminBotAuditEvent[];
  sweeps: AdminBotAutomationSweep[];
  from: string;
  days: number;
}): AutomationRunReport {
  const jobs = new Map<string, Tally>();
  for (const event of input.events) {
    if (event.type !== "automation_health.heartbeat" || event.timestamp < input.from) {
      continue;
    }
    const details = (event.details ?? {}) as Record<string, unknown>;
    if (typeof details.job !== "string") {
      continue;
    }
    const job = jobs.get(details.job) ?? tally();
    jobs.set(details.job, job);
    const metrics = numericRecord(details.metrics);
    note(job, {
      at: event.timestamp,
      ok: details.ok === true,
      ...(typeof details.duration_ms === "number" ? { duration_ms: details.duration_ms } : {}),
      ...(metrics ? { metrics } : {}),
    });
  }
  return {
    from: input.from,
    days: input.days,
    jobs: [...jobs.entries()]
      .map(([job, value]) => ({ job, ...finish(value) }))
      .toSorted((left, right) => left.job.localeCompare(right.job)),
    sweeps: input.sweeps,
  };
}
