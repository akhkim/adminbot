// Composes an onboarding guide email and says what is still missing.
//
// Split from the send so the decision "may this go out yet" is pure and testable: the tab calls
// the same code to preview, and the route calls it again before touching Gmail. A placeholder that
// survives into a delivered email is the failure this exists to prevent -- "{contact_name}" reaching
// a collaborator is worse than the send not happening.
import { findOnboardingTemplate, type AdminBotOnboardingTemplate } from "./emails.js";

// Written into the DCS-address example in the member template as literal copy, not as a value the
// sender fills. Substitution must leave them alone.
const LITERAL_TOKENS = new Set(["first_letter_of_first_name", "full_last_name"]);

// Placeholders filled from deployment configuration rather than from the operator's form. These
// identify the workspace, so they live in the environment and not in the tracked copy.
//
// Required ones are only demanded when the template actually mentions them -- a rejection email
// needs no Slack invite link, so it must still send on a deployment that never configured one.
// Unset while needed is a refusal to send: a placeholder invite link is worse than no email.
const REQUIRED_DEPLOYMENT_TOKENS = {
  slack_invite_url: "ADMINBOT_SLACK_INVITE_URL",
  contact_emails: "ADMINBOT_CONTACT_EMAILS",
  bot_email: "ADMINBOT_BOT_EMAIL",
} as const;

// Optional ones degrade instead: the line carrying them is dropped from the body. Rule 1 forbids
// partially filling a line, so a line mentioning several optional tokens goes if any is unset.
const OPTIONAL_DEPLOYMENT_TOKENS = {
  pi_linkedin_url: "ADMINBOT_PI_LINKEDIN_URL",
  lab_x_url: "ADMINBOT_LAB_X_URL",
} as const;

// Deployment tokens that carry a generic fallback instead of refusing or dropping a line. Only
// safe for values that are purely illustrative: the fallback ships to a real recipient, so it must
// read correctly on a deployment that never configured anything. `email_format_example` shows what
// a "first initial + last name" DCS address looks like -- naming no one is the point, and the lab's
// own address is only a nicer illustration of the same rule.
const DEFAULTED_DEPLOYMENT_TOKENS = {
  email_format_example: {
    varName: "ADMINBOT_EMAIL_FORMAT_EXAMPLE",
    fallback: "zjin@cs.toronto.edu",
  },
} as const;

/**
 * Every placeholder filled from the environment. Templates deliberately leave these out of
 * `required` -- the sender never types them -- so the "no undeclared placeholder" guard needs this
 * list to tell a configured token apart from a typo.
 */
export const ADMINBOT_DEPLOYMENT_TOKENS: readonly string[] = [
  ...Object.keys(REQUIRED_DEPLOYMENT_TOKENS),
  ...Object.keys(OPTIONAL_DEPLOYMENT_TOKENS),
  ...Object.keys(DEFAULTED_DEPLOYMENT_TOKENS),
];

/**
 * Values the *sender* may leave blank. Unlike a `required` token these never refuse the send: the
 * placeholder and one space in front of it disappear together, so "Hi {first_name}," degrades to
 * "Hi," rather than to "Hi ," or to a literal "{first_name}" reaching a recipient.
 *
 * A template that cannot read without one keeps it in `required` instead -- that check runs first,
 * so listing a token here does not weaken any template that demands it.
 */
export const ADMINBOT_OPTIONAL_VALUE_TOKENS: readonly string[] = ["first_name"];

const OPTIONAL_VALUE_TOKENS = new Set(ADMINBOT_OPTIONAL_VALUE_TOKENS);

/** `a@x, b@y` from a comma-separated env value, rendered as the copy reads it. */
function renderList(raw: string): string {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

type DeploymentTokens = {
  values: Record<string, string>;
  /** Env var names a needed required token had no value for. */
  missing: string[];
  /** Optional tokens with no value; any line mentioning one is dropped. */
  unresolvedOptional: Set<string>;
};

function resolveDeploymentTokens(
  template: AdminBotOnboardingTemplate,
  env: NodeJS.ProcessEnv,
): DeploymentTokens {
  const text = `${template.subject ?? ""}\n${template.body}`;
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [token, varName] of Object.entries(REQUIRED_DEPLOYMENT_TOKENS)) {
    if (!text.includes(`{${token}}`)) {
      continue;
    }
    const raw = env[varName]?.trim();
    if (!raw) {
      missing.push(varName);
      continue;
    }
    values[token] = token === "contact_emails" ? renderList(raw) : raw;
  }
  for (const [token, { varName, fallback }] of Object.entries(DEFAULTED_DEPLOYMENT_TOKENS)) {
    if (!text.includes(`{${token}}`)) {
      continue;
    }
    values[token] = env[varName]?.trim() || fallback;
  }
  const unresolvedOptional = new Set<string>();
  for (const [token, varName] of Object.entries(OPTIONAL_DEPLOYMENT_TOKENS)) {
    if (!text.includes(`{${token}}`)) {
      continue;
    }
    const raw = env[varName]?.trim();
    if (raw) {
      values[token] = raw;
    } else {
      unresolvedOptional.add(token);
    }
  }
  return { values, missing, unresolvedOptional };
}

/** Drops whole lines that mention an optional token nothing configured a value for. */
function dropUnresolvedLines(body: string, unresolved: ReadonlySet<string>): string {
  if (unresolved.size === 0) {
    return body;
  }
  const kept = body
    .split("\n")
    .filter((line) => ![...unresolved].some((token) => line.includes(`{${token}}`)));
  // A dropped bullet can leave a run of blank lines behind; collapse so the mail still reads.
  return kept.join("\n").replaceAll(/\n{3,}/gu, "\n\n");
}

export type AdminBotOnboardingValues = Readonly<Record<string, string | undefined>>;

export type AdminBotComposedGuide = {
  template_id: string;
  subject: string;
  body: string;
};

export type AdminBotGuideComposeResult =
  | { ok: true; guide: AdminBotComposedGuide }
  | {
      ok: false;
      missing: string[];
      /**
       * `missing-values` lists placeholder names the operator still has to supply;
       * `missing-environment` lists env var names the deployment has to set.
       */
      reason: "unknown-template" | "missing-values" | "missing-environment";
    };

// The leading-space capture is what lets an unset optional token take its punctuation with it:
// substituting "" alone would leave "Hi ,".
function fill(text: string, values: AdminBotOnboardingValues): string {
  return text.replaceAll(/( ?)\{([a-z_]+)\}/gu, (whole, space: string, token: string) => {
    if (LITERAL_TOKENS.has(token)) {
      return whole;
    }
    const value = values[token]?.trim();
    if (value) {
      return `${space}${value}`;
    }
    return OPTIONAL_VALUE_TOKENS.has(token) ? "" : whole;
  });
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
  env: NodeJS.ProcessEnv = process.env,
): AdminBotGuideComposeResult {
  const template = findOnboardingTemplate(templateId);
  if (!template) {
    return { ok: false, missing: [], reason: "unknown-template" };
  }
  const missing = missingGuideValues(template, values);
  if (missing.length > 0) {
    return { ok: false, missing, reason: "missing-values" };
  }
  const deployment = resolveDeploymentTokens(template, env);
  if (deployment.missing.length > 0) {
    return { ok: false, missing: deployment.missing, reason: "missing-environment" };
  }
  const resolved = { ...values, ...deployment.values };
  // A supplement has no subject of its own because it is appended to another email; sending one
  // standalone still needs something in the header, so fall back rather than ship an empty subject.
  const subject = template.subject
    ? fill(template.subject, resolved)
    : "Working with the Jinesis AI Research Lab";
  return {
    ok: true,
    guide: {
      template_id: template.id,
      subject,
      body: fill(dropUnresolvedLines(template.body, deployment.unresolvedOptional), resolved),
    },
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
