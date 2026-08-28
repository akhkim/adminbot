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
  // The portal's own address. It was previously declared `required` on the alumni mail and marked
  // "derived" on the tab, which meant the field was hidden from the operator and filled by nobody:
  // every alumni send failed the required-values check with a value no one could supply. It is one
  // address for the whole deployment, so it belongs here with the other configured tokens.
  dashboard_url: {
    varName: "ADMINBOT_DASHBOARD_URL",
    fallback: "https://jinesis-admin.vercel.app/",
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

/**
 * An environment value only when someone actually chose it.
 *
 * deploy/aurora/adminbot.env.example seeds thirteen variables as REPLACE_ME_WITH_... so an
 * operator can see what a complete file looks like. Those placeholders are non-empty, so a
 * deployment that installed the template and never edited a line passed every "is it set?" check
 * and failed much later, inside Slack or Gmail, with an error about the value rather than about
 * the configuration. Treating them as unset moves the failure back to the config check, which is
 * the one that can say which variable to set.
 */
export function configuredEnvValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || value.startsWith("REPLACE_ME")) {
    return undefined;
  }
  return value;
}

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

function resolveDeploymentTokens(text: string, env: NodeJS.ProcessEnv): DeploymentTokens {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [token, varName] of Object.entries(REQUIRED_DEPLOYMENT_TOKENS)) {
    if (!text.includes(`{${token}}`)) {
      continue;
    }
    const raw = configuredEnvValue(env[varName]);
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
    values[token] = configuredEnvValue(env[varName]) ?? fallback;
  }
  const unresolvedOptional = new Set<string>();
  for (const [token, varName] of Object.entries(OPTIONAL_DEPLOYMENT_TOKENS)) {
    if (!text.includes(`{${token}}`)) {
      continue;
    }
    const raw = configuredEnvValue(env[varName]);
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

/**
 * Copy the operator edited in the preview, standing in for the stored template.
 *
 * The edited text is still *filled*, not sent verbatim: the preview shows `{drive_folder_link}`
 * and `{slack_connect_link}` unresolved because neither exists until the send provisions them, so
 * an edited body has to go back through substitution or it would deliver the placeholder. Blank
 * means "no edit here" -- an operator who clears the subject box gets the template's subject rather
 * than an empty one.
 */
export type AdminBotGuideOverrides = { subject?: string; body?: string };

/** Placeholders left in composed copy, which is the one thing that must never reach a recipient. */
export function unfilledPlaceholders(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\{([a-z_]+)\}/gu)]
        .map((match) => match[1] as string)
        .filter((token) => !LITERAL_TOKENS.has(token)),
    ),
  ];
}

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

/**
 * Required placeholders with no usable value, in template order.
 *
 * `text` narrows the demand to what the copy being sent actually mentions. It matters only for
 * edited copy: an operator who deleted the sentence carrying `{drive_guide_link}` should not still
 * be asked for a Drive guide link. The stored copy uses every token it declares, so passing its own
 * body changes nothing.
 */
export function missingGuideValues(
  template: AdminBotOnboardingTemplate,
  values: AdminBotOnboardingValues,
  text?: string,
): string[] {
  return template.required.filter(
    (token) => (text === undefined || text.includes(`{${token}}`)) && !values[token]?.trim(),
  );
}

/**
 * Composes the email, or reports what is still needed. Never partially fills: a caller that gets
 * `ok: false` has nothing to send and a concrete list to ask the operator for.
 */
export function composeOnboardingGuide(
  templateId: string,
  values: AdminBotOnboardingValues,
  env: NodeJS.ProcessEnv = process.env,
  overrides: AdminBotGuideOverrides = {},
): AdminBotGuideComposeResult {
  const template = findOnboardingTemplate(templateId);
  if (!template) {
    return { ok: false, missing: [], reason: "unknown-template" };
  }
  const subjectSource = overrides.subject?.trim() ? overrides.subject : template.subject;
  const bodySource = overrides.body?.trim() ? overrides.body : template.body;
  const missing = missingGuideValues(template, values, `${subjectSource ?? ""}\n${bodySource}`);
  if (missing.length > 0) {
    return { ok: false, missing, reason: "missing-values" };
  }
  const deployment = resolveDeploymentTokens(`${subjectSource}\n${bodySource}`, env);
  if (deployment.missing.length > 0) {
    return { ok: false, missing: deployment.missing, reason: "missing-environment" };
  }
  const resolved = { ...values, ...deployment.values };
  // A supplement has no subject of its own because it is appended to another email; sending one
  // standalone still needs something in the header, so fall back rather than ship an empty subject.
  const subject = subjectSource
    ? fill(subjectSource, resolved)
    : "Working with the Jinesis AI Research Lab";
  return {
    ok: true,
    guide: {
      template_id: template.id,
      subject,
      body: fill(dropUnresolvedLines(bodySource, deployment.unresolvedOptional), resolved),
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

/**
 * Rejects an application-form link that is the blank form rather than the applicant's own response.
 *
 * The project-matching mail says "we have forwarded your application form ..." to a project lead
 * who is cc'd, so the link has to open what that applicant actually wrote. The public
 * `/viewform` URL opens an empty form, and the August batch went out with exactly that -- the lead
 * received a blank questionnaire and no way to see the answers they were being asked to judge.
 *
 * A per-responder link is the one Apps Script's `getEditResponseUrl()` returns, which carries an
 * `edit2=` token; a prefilled link carries `usp=pp_url` and its `entry.` parameters. Anything else
 * on a `docs.google.com/forms` host is the blank form under some other spelling. Non-Google links
 * are left alone: the lab sometimes forwards a PDF or a Drive copy instead, and this is a guard
 * against one specific mistake, not a URL allowlist.
 *
 * Returns the problem as a sentence, or undefined when the link is fine.
 */
export function applicantResponseLinkProblem(link: string | undefined): string | undefined {
  const value = link?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "the application form link is not a URL";
  }
  if (!/(^|\.)docs\.google\.com$/u.test(url.hostname) || !url.pathname.includes("/forms/")) {
    return undefined;
  }
  const identifiesOneResponse =
    url.searchParams.has("edit2") ||
    url.searchParams.has("edit_requested") ||
    [...url.searchParams.keys()].some((key) => key.startsWith("entry."));
  if (identifiesOneResponse) {
    return undefined;
  }
  return 'the application form link is the blank form, not this applicant\'s own response: forward the per-person link (the one their "edit response" URL points at) so the project lead sees their answers';
}
