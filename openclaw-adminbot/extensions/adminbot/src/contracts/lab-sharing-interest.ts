export type LabHelpInterest = {
  paper_id: string;
  member_id: string;
  hours_per_week: number;
  note: string;
  status: "active" | "withdrawn";
  created_at: string;
  updated_at: string;
};

// Identity, lifecycle and timestamps are assigned by the service, never by this input.
export function validateHelpInterest(
  input: unknown,
): Pick<LabHelpInterest, "hours_per_week" | "note"> | string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "Expected an offer to help.";
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.hours_per_week !== "number" ||
    !Number.isFinite(value.hours_per_week) ||
    value.hours_per_week <= 0 ||
    value.hours_per_week > 168
  ) {
    return "Hours per week must be greater than 0 and at most 168.";
  }
  if (
    value.note !== undefined &&
    (typeof value.note !== "string" || value.note.trim().length > 1000)
  ) {
    return "Use a note of at most 1000 characters.";
  }
  return {
    hours_per_week: value.hours_per_week,
    note: typeof value.note === "string" ? value.note.trim() : "",
  };
}
