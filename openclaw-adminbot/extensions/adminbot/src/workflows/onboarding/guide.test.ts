import { describe, expect, it, vi } from "vitest";
import { renderEmailBodyHtml } from "../../connectors/email-html.js";
import { ADMINBOT_ONBOARDING_TEMPLATES } from "./emails.js";
import { createAdminBotOnboardingSender } from "./guide-sender.js";
import {
  ADMINBOT_DEPLOYMENT_TOKENS,
  ADMINBOT_OPTIONAL_VALUE_TOKENS,
  composeOnboardingGuide,
  driveWorkspaceFolderName,
  firstNameOf,
  missingGuideValues,
} from "./guide.js";

// The copy's deployment tokens are resolved from the environment, so the tests supply an obviously
// fake workspace rather than letting real identifiers back into the tree.
const ENV: NodeJS.ProcessEnv = {
  ADMINBOT_SLACK_INVITE_URL: "https://join.slack.com/t/example/shared_invite/zt-example",
  ADMINBOT_CONTACT_EMAILS: "ops@example.com, admin@example.com",
  ADMINBOT_BOT_EMAIL: "adminbot@example.com",
  ADMINBOT_PI_LINKEDIN_URL: "https://linkedin.com/in/example-pi/",
  ADMINBOT_LAB_X_URL: "https://x.com/ExampleLab",
  ADMINBOT_ONBOARDING_CHANNEL_ID: "C0EXAMPLE",
};

function valuesFor(templateId: string): Record<string, string> {
  const template = ADMINBOT_ONBOARDING_TEMPLATES.find((entry) => entry.id === templateId);
  return Object.fromEntries((template?.required ?? []).map((token) => [token, `<${token}>`]));
}

describe("onboarding template copy", () => {
  // A wrap inside a paragraph becomes a literal newline in the delivered mail and reads as broken
  // text in most clients, so the copy is stored unwrapped and this keeps it that way.
  it("has no hard wrapping inside a paragraph or bullet", () => {
    for (const template of ADMINBOT_ONBOARDING_TEMPLATES) {
      const lines = template.body.split("\n");
      lines.forEach((line, index) => {
        const next = lines[index + 1];
        if (!line.trim() || !next?.trim()) {
          return;
        }
        // Bullets nest by two-space indent, so "is this a list line" is asked after trimming.
        const opensNewBlock = next.trimStart().startsWith("- ");
        const isSignOffOrLabel = line.trimEnd().endsWith(",") || line.trimEnd().endsWith(":");
        const isListItem = line.trimStart().startsWith("- ") || line.startsWith("Step ");
        expect(
          opensNewBlock || isSignOffOrLabel || isListItem,
          `${template.id} wraps mid-block at line ${index + 1}: ${line.slice(-40)}`,
        ).toBe(true);
      });
    }
  });

  // The recipient has no idea which internal bucket they are in and must not learn it from a
  // subject line.
  it("never names the tier in a subject", () => {
    // The tier *identifiers*, not any word that resembles one. "Collaborating with us on X" and
    // "our collaborators channel" are fine -- they describe the work and the channel. What must
    // never appear is the bucket: "Single-Project Collaborator", "Acquaintance", "coauthor_minor".
    const tierLabels = [
      "coauthor",
      "acquaintance",
      "interviewee",
      "alumni",
      "disappearing",
      "subgroup",
      "single-project",
      "high-commitment",
      "junior collaborator",
      "senior collaborator",
      "external collaborator",
    ];
    for (const template of ADMINBOT_ONBOARDING_TEMPLATES) {
      const subject = template.subject?.toLowerCase() ?? "";
      for (const word of tierLabels) {
        expect(subject.includes(word), `${template.id} subject names the tier: ${subject}`).toBe(
          false,
        );
      }
    }
  });

  it("declares every placeholder its copy uses", () => {
    for (const template of ADMINBOT_ONBOARDING_TEMPLATES) {
      const used = new Set(
        [...`${template.subject ?? ""}\n${template.body}`.matchAll(/\{([a-z_]+)\}/gu)].map(
          (match) => match[1] as string,
        ),
      );
      // The DCS-address example is literal copy, not a value the sender fills.
      used.delete("first_letter_of_first_name");
      used.delete("full_last_name");
      // Deployment tokens come from the environment, so they are deliberately absent from
      // `required`. Removing only the known ones keeps this a real guard: a placeholder that is
      // neither declared nor a configured token still fails here.
      for (const token of ADMINBOT_DEPLOYMENT_TOKENS) {
        used.delete(token);
      }
      // A token a template may render without is not declared -- but only for the templates that
      // actually leave it out. One that lists it in `required` is still held to the equality below.
      for (const token of ADMINBOT_OPTIONAL_VALUE_TOKENS) {
        if (!(template.required as readonly string[]).includes(token)) {
          used.delete(token);
        }
      }
      expect([...used].sort(), template.id).toEqual([...template.required].sort());
    }
  });
});

describe("composeOnboardingGuide", () => {
  it("refuses to compose when a required value is blank", () => {
    const result = composeOnboardingGuide("coauthor_minor", { first_name: "Ada" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("missing-values");
    expect(result.missing).toContain("contact_name");
  });

  it("treats whitespace as missing rather than substituting it", () => {
    const template = ADMINBOT_ONBOARDING_TEMPLATES.find((entry) => entry.id === "acquaintance");
    expect(
      missingGuideValues(template!, { ...valuesFor("acquaintance"), first_name: "   " }),
    ).toEqual(["first_name"]);
  });

  it("fills every placeholder once satisfied", () => {
    const result = composeOnboardingGuide("acquaintance", valuesFor("acquaintance"), ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.guide.body).not.toMatch(/\{[a-z_]+\}/u);
    expect(result.guide.body).toContain(ENV.ADMINBOT_SLACK_INVITE_URL);

    // An unconfigured workspace must refuse rather than mail a placeholder invite link, and must
    // say which variable to set.
    const unset = composeOnboardingGuide("acquaintance", valuesFor("acquaintance"), {});
    expect(unset).toMatchObject({ ok: false, reason: "missing-environment" });
    expect(unset.ok ? [] : unset.missing).toContain("ADMINBOT_SLACK_INVITE_URL");

    // An unset *optional* token is graceful: the line carrying it goes, the email still composes,
    // and no half-rendered placeholder survives.
    const noSocials = composeOnboardingGuide("acquaintance", valuesFor("acquaintance"), {
      ADMINBOT_SLACK_INVITE_URL: ENV.ADMINBOT_SLACK_INVITE_URL,
    });
    expect(noSocials.ok).toBe(true);
    if (!noSocials.ok) {
      return;
    }
    expect(noSocials.guide.body).not.toMatch(/\{[a-z_]+\}/u);
    expect(noSocials.guide.body).not.toContain("If you want to follow what we publish");
  });

  // The DCS-address example must survive substitution literally, and the address it illustrates
  // comes from the environment with a generic fallback -- it is an example, so an unconfigured
  // deployment still sends rather than refusing.
  it("leaves the member template's example tokens alone", () => {
    const result = composeOnboardingGuide("member", { first_name: "Ada" }, ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The naming *pattern* is notation, not a token to fill: it shows the shape of an address, so
    // it survives compose verbatim while the worked example beside it is configurable.
    expect(result.guide.body).toContain("{first_letter_of_first_name}{full_last_name}");
    expect(result.guide.body).toContain("Hi Ada,");
    // Both routes to an account are described: already have a DCS address, or waiting on one.
    expect(result.guide.body).toContain("If you already have an @cs.toronto.edu email");
    expect(result.guide.body).toContain("If you do not have an @cs.toronto.edu email yet");
    // Accounts are pre-created for the roster right now, so the mail hands over a sign-in and a
    // temporary password rather than a signup link.
    expect(result.guide.body).toContain("https://jinesis-admin.vercel.app");
    expect(result.guide.body).toContain('temporary password "jinesis"');
    expect(result.guide.body).not.toContain("/signup");
    // The member is never told to file the DCS request themselves; approval does it for them.
    expect(result.guide.body).not.toContain("forms.office.com");
    expect(result.guide.body).not.toContain("click this link");
    expect(result.guide.body).not.toContain("mentee handbook");
    // The escalation route is a named person with a deadline.
    expect(result.guide.body).toContain("over 2 business days");
    expect(result.guide.body).toContain("akim@cs.toronto.edu");

    expect(result.guide.body).toContain('e.g., "zjin@cs.toronto.edu"');
    const configured = composeOnboardingGuide("member", { first_name: "Ada" }, {
      ...ENV,
      ADMINBOT_EMAIL_FORMAT_EXAMPLE: "aa@cs.example.edu",
    } satisfies NodeJS.ProcessEnv);
    expect(configured.ok ? configured.guide.body : "").toContain('e.g., "aa@cs.example.edu"');

    // `first_name` is optional here: no name means "Hi," rather than a refusal or a stray comma.
    const anonymous = composeOnboardingGuide("member", {}, ENV);
    expect(anonymous.ok).toBe(true);
    expect(anonymous.ok ? anonymous.guide.body : "").toMatch(/^Hi,\n/u);
    expect(anonymous.ok ? anonymous.guide.body : "").not.toMatch(/\{first_name\}/u);

    // The optional token stays optional only where a template declines to require it: the other
    // templates still refuse rather than greet a stranger with "Hi,".
    expect(composeOnboardingGuide("interview_invite", {}, ENV)).toMatchObject({
      ok: false,
      reason: "missing-values",
      missing: ["first_name"],
    });

    // The member email now names its escalation contact directly, so it no longer depends on
    // ADMINBOT_CONTACT_EMAILS and composes on a deployment that never set it. No template
    // references {contact_emails} any more -- if one does again, this is the guard that should be
    // restored alongside it.
    expect(composeOnboardingGuide("member", { first_name: "Ada" }, {})).toMatchObject({
      ok: true,
    });
  });

  // deploy/aurora/adminbot.env.example seeds thirteen variables as REPLACE_ME_WITH_..., and those
  // placeholders are non-empty. Without this they satisfy every "is it set?" check and the failure
  // surfaces much later, from Slack or Gmail, describing the value rather than the configuration.
  it("treats an unedited REPLACE_ME placeholder as unset", () => {
    const result = composeOnboardingGuide("acquaintance", valuesFor("acquaintance"), {
      ADMINBOT_SLACK_INVITE_URL: "REPLACE_ME_WITH_THE_SLACK_INVITE_URL",
    });
    expect(result).toMatchObject({ ok: false, reason: "missing-environment" });
    expect(result.ok ? [] : result.missing).toContain("ADMINBOT_SLACK_INVITE_URL");
  });

  it("falls back to the shipped example when a defaulted token is still a placeholder", () => {
    const result = composeOnboardingGuide("member", { first_name: "Ada" }, {
      ADMINBOT_EMAIL_FORMAT_EXAMPLE: "REPLACE_ME_WITH_AN_EXAMPLE_ADDRESS",
    } satisfies NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
    // The illustration a recipient reads must never be the operator's unfilled placeholder.
    expect(result.ok ? result.guide.body : "").toContain('e.g., "zjin@cs.toronto.edu"');
    expect(result.ok ? result.guide.body : "").not.toContain("REPLACE_ME");
  });

  it("rejects an unknown template", () => {
    expect(composeOnboardingGuide("nope", {})).toMatchObject({ reason: "unknown-template" });
  });
});

describe("driveWorkspaceFolderName", () => {
  it.each([
    ["Andrew Kim", "Zhijing-AndrewKim"],
    ["Maria Garcia Lopez", "Zhijing-MariaGarcia"],
    ["  Ada   Lovelace  ", "Zhijing-AdaLovelace"],
    ["Zhijing", "Zhijing-Zhijing"],
  ])("%s -> %s", (input, expected) => {
    expect(driveWorkspaceFolderName(input)).toBe(expected);
  });

  it("refuses an empty name rather than creating Zhijing-", () => {
    expect(() => driveWorkspaceFolderName("   ")).toThrow(/name is required/u);
  });
});

describe("onboarding sender", () => {
  it("asks for every missing value at once, before provisioning anything", async () => {
    const provisionDriveWorkspace = vi.fn();
    const sendEmail = vi.fn();
    const send = createAdminBotOnboardingSender({ env: ENV, provisionDriveWorkspace, sendEmail });

    const result = await send({
      template_id: "coauthor_minor",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.status).toBe(422);
    expect(result.error.missing).toEqual(
      expect.arrayContaining(["contact_name", "discussion_channel", "meeting_cadence"]),
    );
    // Nothing was created for a send that could never have gone out.
    expect(provisionDriveWorkspace).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("provisions Drive and Slack, then sends", async () => {
    const provisionDriveWorkspace = vi
      .fn()
      .mockResolvedValue({ folderId: "fld", link: "https://drive.example/fld" });
    const inviteToSlackConnect = vi.fn().mockResolvedValue({ url: "https://slack.example/invite" });
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({
      env: ENV,
      provisionDriveWorkspace,
      inviteToSlackConnect,
      sendEmail,
    });

    const result = await send({
      template_id: "trial_phase",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(provisionDriveWorkspace).toHaveBeenCalledWith({ folderName: "Zhijing-AdaLovelace" });
    expect(result.payload.sent).toBe(true);
    expect(result.payload.body).toContain("https://drive.example/fld");
    expect(result.payload.body).toContain("https://slack.example/invite");
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@example.com", subject: expect.any(String) }),
    );
    // The send carries an html alternative rendered from the same body, so the delivered mail is
    // not hard-wrapped mid-paragraph; the plain text stays the canonical copy.
    expect(result.payload.body_html).toBe(renderEmailBodyHtml(result.payload.body));
    expect(sendEmail.mock.calls[0]?.[0]?.body_html).toBe(result.payload.body_html);
  });

  it("does not send when provisioning is unavailable", async () => {
    const sendEmail = vi.fn();
    const send = createAdminBotOnboardingSender({ env: ENV, sendEmail });
    const result = await send({
      template_id: "trial_phase",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(result.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("previews without provisioning or sending", async () => {
    const provisionDriveWorkspace = vi.fn();
    const sendEmail = vi.fn();
    const send = createAdminBotOnboardingSender({ env: ENV, provisionDriveWorkspace, sendEmail });
    const result = await send({
      template_id: "trial_phase",
      name: "Ada Lovelace",
      email: "ada@example.com",
      preview: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sent).toBe(false);
    expect(provisionDriveWorkspace).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("resolves the WhatsApp number from settings rather than the repo", async () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({
      env: ENV,
      sendEmail,
      headProfessorWhatsapp: () => "+00 000 000",
    });
    const result = await send({
      template_id: "member_what_to_expect",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.body).toContain("+00 000 000");
  });

  it("will not send when the settings number is unset", async () => {
    const sendEmail = vi.fn();
    const send = createAdminBotOnboardingSender({
      env: ENV,
      sendEmail,
      headProfessorWhatsapp: () => undefined,
    });
    const result = await send({
      template_id: "member_what_to_expect",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(result.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("derives the first name from the full name", () => {
    expect(firstNameOf("Maria Garcia Lopez")).toBe("Maria");
  });
});
