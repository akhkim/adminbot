// What the head of the lab is telling everybody right now, and everything she has told them before.
//
// This began as a single current status and grew a history, because the two answer different
// questions. "Where is Zhijing this week" is answered by the latest entry and goes stale on its own
// expiry. "What did she say about the Ann Arbor trip" is answered by the archive, and an archive is
// exactly what a single-row table cannot hold: every publish overwrote the last one, so the lab's
// own record of what it had been told was always one sentence long.
//
// Append-only, therefore. Publishing adds; clearing retracts the current entry rather than deleting
// it. A broadcast that went out to everybody is a thing that happened, and "I never said that" is
// not a state the record should be able to reach.

export type LabDirectorStatus = {
  /**
   * Stable per broadcast. Absent from rows written before the history existed, which is why the
   * migration mints one rather than leaving the field optional for readers to handle.
   */
  id: string;
  availability: "available" | "busy" | "away" | "unknown";
  message: string;
  expires_at: string;
  updated_at: string;
  updated_by: string;
  /**
   * When this broadcast was taken down early, if it was.
   *
   * Distinct from expiry: expiring is the broadcast doing what it was published to do, retracting
   * is somebody stopping it. Both hide it from the banner; only retraction is worth a reader of the
   * archive knowing about.
   */
  retracted_at?: string;
};

/** How many past broadcasts the archive hands back. Enough to scroll, short of a download. */
export const ADMINBOT_BROADCAST_HISTORY_LIMIT = 50;

export function validateDirectorStatus(
  input: unknown,
  now: number,
): Pick<LabDirectorStatus, "availability" | "message" | "expires_at"> | string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "Expected a shared status.";
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.availability !== "string" ||
    !["available", "busy", "away", "unknown"].includes(value.availability)
  ) {
    return "Choose available, busy, away, or unknown.";
  }
  if (
    typeof value.message !== "string" ||
    !value.message.trim() ||
    value.message.trim().length > 500
  ) {
    return "Use a status message of 1 to 500 characters.";
  }
  // Require an explicit timezone so the server never interprets an editor's local time.
  if (
    typeof value.expires_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value.expires_at,
    )
  ) {
    return "Provide an expiry timestamp with a timezone.";
  }
  const expiry = Date.parse(value.expires_at);
  if (!Number.isFinite(now) || !Number.isFinite(expiry) || expiry <= now) {
    return "Expiry must be in the future.";
  }
  return {
    availability: value.availability as LabDirectorStatus["availability"],
    message: value.message.trim(),
    expires_at: new Date(expiry).toISOString(),
  };
}

/**
 * Whether one broadcast is the one to show at the top of the page.
 *
 * Three ways to not be: retracted, expired, or absent. Kept as one predicate so the banner, the
 * archive's "current" marker and the service's own read cannot disagree about which entry is live.
 */
export function currentDirectorStatus(
  status: LabDirectorStatus | null,
  now: number,
): LabDirectorStatus | null {
  if (!status || status.retracted_at || !Number.isFinite(now)) {
    return null;
  }
  return Date.parse(status.expires_at) > now ? status : null;
}

/**
 * The live broadcast out of a history, newest first.
 *
 * Only the newest entry can be current. An older one whose expiry happens to run longer is still
 * superseded -- the lab reads the most recent thing it was told, not the one that lasts longest.
 */
export function currentBroadcast(
  history: readonly LabDirectorStatus[],
  now: number,
): LabDirectorStatus | null {
  return currentDirectorStatus(history[0] ?? null, now);
}
