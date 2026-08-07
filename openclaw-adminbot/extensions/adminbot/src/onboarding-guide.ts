// Composes an onboarding guide email and says what is still missing.
//
// Split from the send so the decision "may this go out yet" is pure and testable: the tab calls
// the same code to preview, and the route calls it again before touching Gmail. A placeholder that
// survives into a delivered email is the failure this exists to prevent -- "{contact_name}" reaching
// a collaborator is worse than the send not happening.
import { findOnboardingTemplate, type AdminBotOnboardingTemplate } from "./onboarding-emails.js";

// Written into the DCS-address example in the member template as literal copy, not as a value the
// sender fills. Substitution must leave them alone.
const LITERAL_TOKENS = new Set(["first_letter_of_first_name", "full_last_name"]);

export type AdminBotOnboardingValues = Readonly<Record<string, string | undefined>>;

export type AdminBotComposedGuide = {
  template_id: string;
  subject: string;
  body: string;
};

export type AdminBotGuideComposeResult =
  | { ok: true; guide: AdminBotComposedGuide }
  | { ok: false; missing: string[]; reason: "unknown-template" | "missing-values" };

function fill(text: string, values: AdminBotOnboardingValues): string {
  return text.replaceAll(/\{([a-z_]+)\}/gu, (whole, token: string) =>
    LITERAL_TOKENS.has(token) ? whole : (values[token]?.trim() ?? whole),
  );
}

/** Required placeholders with no usable value, in template order. */
export function missingGuideValues(
  template: AdminBotOnboardingTemplate,
  values: AdminBotOnboardingValues,
): string[] {
  return template.required.filter((token) => !values[token]?.trim());
}

/**
 * Composes the email, or reports what is still needed. Never partially fills: a caller that gets
 * `ok: false` has nothing to send and a concrete list to ask the operator for.
 */
export function composeOnboardingGuide(
  templateId: string,
  values: AdminBotOnboardingValues,
): AdminBotGuideComposeResult {
  const template = findOnboardingTemplate(templateId);
  if (!template) {
    return { ok: false, missing: [], reason: "unknown-template" };
  }
  const missing = missingGuideValues(template, values);
  if (missing.length > 0) {
    return { ok: false, missing, reason: "missing-values" };
  }
  // A supplement has no subject of its own because it is appended to another email; sending one
  // standalone still needs something in the header, so fall back rather than ship an empty subject.
  const subject = template.subject
    ? fill(template.subject, values)
    : "Working with the Jinesis AI Research Lab";
  return {
    ok: true,
    guide: { template_id: template.id, subject, body: fill(template.body, values) },
  };
}

/**
 * The Drive workspace folder name for a person: the first two parts of their name, joined.
 * "Andrew Kim" -> Zhijing-AndrewKim, "Maria Garcia Lopez" -> Zhijing-MariaGarcia, matching the
 * `Zhijing-StudentName` prototype the folder is copied from.
 */
export function driveWorkspaceFolderName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("a name is required to build the Drive workspace folder name");
  }
  return `Zhijing-${parts.slice(0, 2).join("")}`;
}

/** First name for `{first_name}`; the whole string when there is only one part. */
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/u).find(Boolean) ?? "";
}
