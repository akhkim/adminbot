export type LabHelpRequest = {
  paper_id: string;
  owner_id: string;
  description: string;
  tags: string[];
  members_needed: number;
  hours_per_week: number;
  timeline: string;
  status: "open" | "closed";
  created_at: string;
  updated_at: string;
};

export function validateHelpRequest(
  input: unknown,
): Omit<LabHelpRequest, "paper_id" | "owner_id" | "status" | "created_at" | "updated_at"> | string {
  if (!input || typeof input !== "object" || Array.isArray(input))
    {return "Expected a help request.";}
  const value = input as Record<string, unknown>;
  if (
    typeof value.description !== "string" ||
    !value.description.trim() ||
    value.description.trim().length > 4000
  )
    {return "Describe the tasks in 1–4000 characters.";}
  if (
    !Array.isArray(value.tags) ||
    value.tags.length > 10 ||
    value.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 40)
  )
    {return "Use at most 10 tags of 1–40 characters.";}
  if (
    !Number.isInteger(value.members_needed) ||
    Number(value.members_needed) < 1 ||
    Number(value.members_needed) > 100
  )
    {return "Members needed must be a whole number from 1 to 100.";}
  if (
    typeof value.hours_per_week !== "number" ||
    !Number.isFinite(value.hours_per_week) ||
    value.hours_per_week <= 0 ||
    value.hours_per_week > 168
  )
    {return "Hours per week must be greater than 0 and at most 168.";}
  if (
    value.timeline !== undefined &&
    (typeof value.timeline !== "string" || value.timeline.length > 300)
  )
    {return "Timeline must be at most 300 characters.";}
  return {
    description: value.description.trim(),
    tags: [...new Set((value.tags as string[]).map((tag) => tag.trim().toLowerCase()))],
    members_needed: Number(value.members_needed),
    hours_per_week: value.hours_per_week,
    timeline: typeof value.timeline === "string" ? value.timeline.trim() : "",
  };
}
