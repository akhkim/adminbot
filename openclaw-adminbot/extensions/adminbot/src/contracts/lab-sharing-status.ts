export type LabDirectorStatus = {
  availability: "available" | "busy" | "away" | "unknown";
  message: string;
  expires_at: string;
  updated_at: string;
  updated_by: string;
};

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

export function currentDirectorStatus(
  status: LabDirectorStatus | null,
  now: number,
): LabDirectorStatus | null {
  return status && Number.isFinite(now) && Date.parse(status.expires_at) > now ? status : null;
}
