import fs from "node:fs";

/**
 * Hands a cron job's counters to adminbot-cron-run.sh, which sends them with the job's heartbeat.
 *
 * The wrapper names a file in ADMINBOT_RUN_METRICS_FILE and this appends `name<TAB>count` lines to
 * it. Only counts leave the job: no subjects, addresses or error text. Outside the wrapper (a manual
 * run) the variable is unset and this does nothing. A failed write never fails the job.
 */
export function writeRunMetrics(
  counts: Record<string, number | undefined>,
  file = process.env.ADMINBOT_RUN_METRICS_FILE,
): void {
  if (!file) {
    return;
  }
  const lines = Object.entries(counts)
    .filter(([, value]) => Number.isSafeInteger(value) && (value ?? -1) >= 0)
    .map(([name, value]) => `${name}\t${value}\n`)
    .join("");
  try {
    fs.appendFileSync(file, lines);
  } catch {
    // The heartbeat goes out without counters; the run itself is unaffected.
  }
}
