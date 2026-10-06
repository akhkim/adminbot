import { adminBotMemberAnswerableProfileFields } from "./actions.js";

// Shared by the profile gate and the reminder service so conditional requirements cannot drift.
export function missingMandatoryProfileFields(member: object): string[] {
  const fields = member as Record<string, unknown>;
  return adminBotMemberAnswerableProfileFields.filter((key) => {
    if (key === "arr_review_capacity" && fields.arr_reviewer_qualified !== true) return false;
    if (key === "intake_form_url" && fields.intake_form_unavailable === true) return false;
    const value = fields[key];
    if (Array.isArray(value)) return value.filter(Boolean).length === 0;
    return value === undefined || value === null || String(value).trim() === "";
  });
}

export function requiresProfileCompletion(member: object): boolean {
  return (
    (member as { privilege_level?: string }).privilege_level === "member" &&
    missingMandatoryProfileFields(member).length > 0
  );
}
