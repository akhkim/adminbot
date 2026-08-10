/**
 * Run stage: command-lane enqueue shaping.
 *
 * The run loop hands each attempt to the command queue. These helpers decide the
 * lane's task timeout — the caller's own timeout plus a grace window, so the lane
 * watchdog never fires before the attempt's own deadline — and the queue priority
 * the trigger deserves.
 */
import type { CommandQueueEnqueueOptions } from "../../../process/command-queue.types.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export const EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS = 30_000;
export const EMBEDDED_RUN_LANE_HEARTBEAT_MS = EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS / 2;

export function resolveEmbeddedRunLaneTimeoutMs(timeoutMs: number): number | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.floor(timeoutMs) + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;
}

export function withEmbeddedRunLaneTimeout(
  opts: CommandQueueEnqueueOptions | undefined,
  laneTaskTimeoutMs: number | undefined,
): CommandQueueEnqueueOptions | undefined {
  if (laneTaskTimeoutMs === undefined || opts?.taskTimeoutMs !== undefined) {
    return opts;
  }
  return { ...opts, taskTimeoutMs: laneTaskTimeoutMs };
}

export function resolveEmbeddedRunSessionQueuePriority(
  trigger: RunEmbeddedAgentParams["trigger"],
): CommandQueueEnqueueOptions["priority"] {
  switch (trigger) {
    case "user":
    case "manual":
      return "foreground";
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "background";
    default:
      return "normal";
  }
}
