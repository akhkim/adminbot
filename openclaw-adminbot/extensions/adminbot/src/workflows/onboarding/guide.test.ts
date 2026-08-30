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
    const result = composeOnboardingGuide("coauthor_major", { first_name: "Ada" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("missing-values");
    // The setup mail hands over a portal sign-in and points at the Drive practice guide; the
    // project itself and who supervises the work are in the norms mail that follows it. The
    // password is not on this list -- it is the same seeded string for everyone, so it is a
    // configured deployment token rather than a field.
    expect(result.missing).toContain("drive_guide_link");
    expect(result.missing).not.toContain("portal_password");
  });

  // The mail's whole job here is to tell the reader what to type the first time they sign in, so
  // the seeded password has to reach the copy without anybody retyping it.
  it("fills the seeded portal password without being given one", () => {
    const result = composeOnboardingGuide(
      "coauthor_major",
      {
        first_name: "Ada",
        member_email: "ada@cs.toronto.edu",
        drive_folder_link: "https://drive.example/folder",
        drive_guide_link: "https://drive.example/guide",
      },
      ENV,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.guide.body).toContain("password jinesis");
    expect(result.guide.body).not.toMatch(/\{[a-z_]+\}/u);
  });

  it("lets a deployment that reseeded say so", () => {
    const result = composeOnboardingGuide(
      "coauthor_major",
      {
        first_name: "Ada",
        member_email: "ada@cs.toronto.edu",
        drive_folder_link: "https://drive.example/folder",
        drive_guide_link: "https://drive.example/guide",
      },
      { ...ENV, ADMINBOT_SEEDED_PORTAL_PASSWORD: "something-else" },
    );
    expect(result.ok && result.guide.body).toContain("something-else");
  });

  // The alumni mail asked for a portal address the tab hid from the operator and nothing filled,
  // so every alumni send failed on a value no one could supply. It is deployment config now.
  it("fills the dashboard address from configuration rather than from the sender", () => {
    const result = composeOnboardingGuide(
      "alumni",
      { first_name: "Ada", sender_name: "Zhijing", slack_connect_link: "https://slack.example" },
      ENV,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.guide.body).toContain("https://jinesis-admin.vercel.app/");

    const configured = composeOnboardingGuide(
      "alumni",
      { first_name: "Ada", sender_name: "Zhijing", slack_connect_link: "https://slack.example" },
      { ...ENV, ADMINBOT_DASHBOARD_URL: "https://portal.example" },
    );
    expect(configured.ok && configured.guide.body).toContain("https://portal.example");
  });

  it("treats whitespace as missing rather than substituting it", () => {
    const template = ADMINBOT_ONBOARDING_TEMPLATES.find((entry) => entry.id === "interviewee");
    expect(
      missingGuideValues(template!, { ...valuesFor("interviewee"), first_name: "   " }),
    ).toEqual(["first_name"]);
  });

  it("fills every placeholder once satisfied", () => {
    const result = composeOnboardingGuide("interviewee", valuesFor("interviewee"), ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.guide.body).not.toMatch(/\{[a-z_]+\}/u);
    expect(result.guide.body).toContain(ENV.ADMINBOT_SLACK_INVITE_URL);

    // An unconfigured workspace must refuse rather than mail a placeholder invite link, and must
    // say which variable to set.
    const unset = composeOnboardingGuide("interviewee", valuesFor("interviewee"), {});
    expect(unset).toMatchObject({ ok: false, reason: "missing-environment" });
    expect(unset.ok ? [] : unset.missing).toContain("ADMINBOT_SLACK_INVITE_URL");

    // An unset *optional* token is graceful: the line carrying it goes, the email still composes,
    // and no half-rendered placeholder survives.
    const noSocials = composeOnboardingGuide("interviewee", valuesFor("interviewee"), {
      ADMINBOT_SLACK_INVITE_URL: ENV.ADMINBOT_SLACK_INVITE_URL,
    });
    expect(noSocials.ok).toBe(true);
    if (!noSocials.ok) {
      return;
    }
    expect(noSocials.guide.body).not.toMatch(/\{[a-z_]+\}/u);
    expect(noSocials.guide.body).not.toContain("If you would like to follow along more generally");
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
    expect(composeOnboardingGuide("rejection", {}, ENV)).toMatchObject({
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
    const result = composeOnboardingGuide("interviewee", valuesFor("interviewee"), {
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
      template_id: "coauthor_major",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.status).toBe(422);
    // `drive_folder_link` is not on this list: it is provisioned by the send rather than typed.
    // `member_email` is not either -- it defaults to the address being written to. Nor is
    // `portal_password`, which is the same seeded value for every account and is filled in.
    expect(result.error.missing).toEqual(expect.arrayContaining(["drive_guide_link"]));
    expect(result.error.missing).not.toContain("portal_password");
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
    // Trial phase is not full membership, so the folder is created and shared but left empty.
    expect(provisionDriveWorkspace).toHaveBeenCalledWith({
      folderName: "Zhijing-AdaLovelace",
      includeContents: false,
    });
    expect(result.payload.sent).toBe(true);
    expect(result.payload.body).toContain("https://drive.example/fld");
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@example.com", subject: expect.any(String) }),
    );
    // The send carries an html alternative rendered from the same body, so the delivered mail is
    // not hard-wrapped mid-paragraph; the plain text stays the canonical copy.
    expect(result.payload.body_html).toBe(renderEmailBodyHtml(result.payload.body));
    expect(sendEmail.mock.calls[0]?.[0]?.body_html).toBe(result.payload.body_html);
  });

  // The full-member guide is what starts someone's CS account, and its own copy tells them an
  // account request is coming -- so sending it files the request. This used to happen on
  // registration approval, which is too late: by then they have the address the request produces.
  it("files the DCS request when the full-member guide is sent", async () => {
    const submitDcsForm = vi.fn().mockResolvedValue(undefined);
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({ env: ENV, submitDcsForm, sendEmail });

    const result = await send({
      template_id: "member",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(result.ok).toBe(true);
    expect(submitDcsForm).toHaveBeenCalledWith({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    });
    if (result.ok) {
      expect(result.payload.dcs_form).toEqual({ submitted: true });
    }
  });

  // Every other template goes to people who are not getting a CS account from this lab.
  it("files nothing for the other templates", async () => {
    const submitDcsForm = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({
      env: ENV,
      submitDcsForm,
      sendEmail: vi.fn().mockResolvedValue(undefined),
    });
    const result = await send({
      template_id: "rejection",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(result.ok).toBe(true);
    expect(submitDcsForm).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.payload.dcs_form).toBeUndefined();
    }
  });

  // A re-send is not a second request: an operator resending the guide to someone who already has
  // an account turns it off.
  it("lets a re-send opt out", async () => {
    const submitDcsForm = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({
      env: ENV,
      submitDcsForm,
      sendEmail: vi.fn().mockResolvedValue(undefined),
    });
    const result = await send({
      template_id: "member",
      name: "Ada Lovelace",
      email: "ada@example.com",
      submit_dcs_form: false,
    });
    expect(result.ok).toBe(true);
    expect(submitDcsForm).not.toHaveBeenCalled();
  });

  // The guide is already delivered by the time the form runs, so a failed form is reported and
  // followed up, never a reason to tell the operator the send failed.
  it("reports a failed DCS request without failing the send", async () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({
      env: ENV,
      sendEmail,
      submitDcsForm: vi.fn().mockRejectedValue(new Error("form timed out")),
    });
    const result = await send({
      template_id: "member",
      name: "Ada Lovelace",
      email: "ada@example.com",
      submit_dcs_form: true,
    });
    expect(result.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalled();
    if (result.ok) {
      expect(result.payload.sent).toBe(true);
      expect(result.payload.dcs_form).toEqual({ submitted: false, error: "form timed out" });
    }
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

  // The preview is what the tab hands back as the body to send, so the two links that do not exist
  // yet stay as their own placeholders rather than as a sentence describing them.
  it("previews the provisioned links as placeholders", async () => {
    const send = createAdminBotOnboardingSender({ env: ENV, sendEmail: vi.fn() });
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
    expect(result.payload.body).toContain("{drive_folder_link}");
  });

  it("sends the operator's edited copy, with the provisioned links filled in", async () => {
    const provisionDriveWorkspace = vi
      .fn()
      .mockResolvedValue({ folderId: "fld", link: "https://drive.example/fld" });
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({ env: ENV, provisionDriveWorkspace, sendEmail });

    const result = await send({
      template_id: "trial_phase",
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject_override: "Your trial with us",
      body_override: "Hi Ada,\n\nYour workspace: {drive_folder_link}\n\nWarmly,\nAdminBot",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.subject).toBe("Your trial with us");
    expect(result.payload.body).toContain("Your workspace: https://drive.example/fld");
    // The stored copy is a starting draft; nothing of it survives an edit that removed it.
    expect(result.payload.body).not.toContain("three weeks");
    expect(sendEmail.mock.calls[0]?.[0]?.subject).toBe("Your trial with us");
  });

  // Rule 1 holds for edited copy too, and the refusal comes before provisioning: finding out
  // afterwards would leave a Drive folder and a Slack invite behind for a mail that never went.
  it("refuses edited copy that still holds a placeholder, before provisioning anything", async () => {
    const provisionDriveWorkspace = vi.fn();
    const sendEmail = vi.fn();
    const send = createAdminBotOnboardingSender({ env: ENV, provisionDriveWorkspace, sendEmail });

    const result = await send({
      template_id: "trial_phase",
      name: "Ada Lovelace",
      email: "ada@example.com",
      body_override:
        "Hi Ada, your lead is {interview_lead} and your folder is {drive_folder_link}.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.status).toBe(422);
    expect(result.error.missing).toEqual(["interview_lead"]);
    expect(provisionDriveWorkspace).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // An operator who deleted the sentence a value belonged to should not still be asked for it.
  it("asks only for the values the edited copy still mentions", async () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({ env: ENV, sendEmail });

    const result = await send({
      template_id: "coauthor_minor",
      name: "Ada Lovelace",
      email: "ada@example.com",
      body_override: "Hi Ada,\n\nWelcome aboard.\n\nBest regards,\nAdminBot",
    });

    expect(result.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalled();
  });

  // The coauthor mails promise a project-channel invite; until this existed nothing made that
  // true, because the Connect invite only ever went to the one configured onboarding channel.
  it("invites the recipient to each project channel before the mail goes out", async () => {
    const order: string[] = [];
    const inviteToSlackConnect = vi.fn(async ({ channelId }: { channelId: string }) => {
      order.push(`invite:${channelId}`);
      return { url: `https://slack.example/${channelId}` };
    });
    const sendEmail = vi.fn(async () => {
      order.push("send");
    });
    const send = createAdminBotOnboardingSender({ env: ENV, inviteToSlackConnect, sendEmail });

    const result = await send({
      template_id: "disappearing_coauthor",
      name: "Ada Lovelace",
      email: "ada@example.com",
      values: { project_or_context: "alg-circuit" },
      slack_project_channels: ["#proj-alg-circuit", "#proj-alg-circuit", " "],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Deduplicated, blanks dropped, and every invite lands before the mail.
    expect(order).toEqual(["invite:#proj-alg-circuit", "send"]);
    expect(result.payload.project_channel_invites).toEqual([
      { channel: "#proj-alg-circuit", url: "https://slack.example/#proj-alg-circuit" },
    ]);
  });

  // Slack answers a successful inviteShared without a url when the address already belongs to a
  // Slack account. Treating that as failure withheld the email from five people Slack had already
  // invited, which is the exact inverse of what the invite-then-send ordering is for.
  it("sends when Slack invites without handing back a shareable link", async () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const send = createAdminBotOnboardingSender({
      env: ENV,
      inviteToSlackConnect: vi.fn().mockResolvedValue({ url: "" }),
      sendEmail,
    });

    const result = await send({
      template_id: "alumni",
      name: "Ada Lovelace",
      email: "ada@example.com",
      values: { sender_name: "Zhijing" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(sendEmail).toHaveBeenCalled();
    expect(result.payload.body).toContain("check your inbox for the Slack invitation");
    expect(result.payload.body).not.toMatch(/\{[a-z_]+\}/u);
  });

  // not_in_channel is the everyday case: a bot can only invite into a channel it is in. It used to
  // escape as an exception and end the batch on whichever recipient hit it first.
  it("refuses one send, rather than throwing, when the onboarding-channel invite fails", async () => {
    const sendEmail = vi.fn();
    const send = createAdminBotOnboardingSender({
      env: ENV,
      inviteToSlackConnect: vi
        .fn()
        .mockRejectedValue(new Error("An API error occurred: not_in_channel")),
      sendEmail,
    });

    const result = await send({
      template_id: "alumni",
      name: "Ada Lovelace",
      email: "ada@example.com",
      values: { sender_name: "Zhijing" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.status).toBe(502);
    expect(result.error.message).toContain("not_in_channel");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not send when a project-channel invite fails", async () => {
    const sendEmail = vi.fn();
    const send = createAdminBotOnboardingSender({
      env: ENV,
      inviteToSlackConnect: vi
        .fn()
        .mockRejectedValue(new Error("no Slack channel named #proj-typo")),
      sendEmail,
    });

    const result = await send({
      template_id: "disappearing_coauthor",
      name: "Ada Lovelace",
      email: "ada@example.com",
      values: { project_or_context: "alg-circuit" },
      slack_project_channels: ["#proj-typo"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.status).toBe(502);
    expect(result.error.message).toContain("#proj-typo");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("derives the first name from the full name", () => {
    expect(firstNameOf("Maria Garcia Lopez")).toBe("Maria");
  });
});

describe("reusing a Slack Connect invite", () => {
  const CHANNEL_ENV = { ...ENV, ADMINBOT_ONBOARDING_CHANNEL_ID: "C0EXAMPLE" };

  function cache(seed?: { url: string; created_at: string }) {
    const rows = new Map<string, { email: string; channel_id: string } & typeof seedValue>();
    const seedValue = { url: "", created_at: "" };
    if (seed) {
      rows.set("ada@example.com C0EXAMPLE", {
        email: "ada@example.com",
        channel_id: "C0EXAMPLE",
        ...seed,
      });
    }
    return {
      rows,
      get: (email: string, channelId: string) => rows.get(`${email} ${channelId}`),
      save: (invite: { email: string; channel_id: string; url: string; created_at: string }) => {
        rows.set(`${invite.email} ${invite.channel_id}`, invite);
      },
    };
  }

  function sendWith(
    inviteCache: ReturnType<typeof cache>,
    inviteToSlackConnect: ReturnType<typeof vi.fn>,
    now: Date,
  ) {
    return createAdminBotOnboardingSender({
      env: CHANNEL_ENV,
      inviteToSlackConnect,
      sendEmail: vi.fn().mockResolvedValue(undefined),
      slackConnectInviteCache: inviteCache,
      now: () => now,
    })({ template_id: "alumni", name: "Ada Lovelace", email: "ada@example.com" });
  }

  // Minting one per send filled the recipient's inbox with a fresh Slack invitation every time a
  // mail was corrected and re-sent, and left several live invitations to the same channel.
  it("hands out a link minted eight days ago instead of minting another", async () => {
    const inviteCache = cache({
      url: "https://slack.example/first",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    const inviteToSlackConnect = vi.fn();
    const result = await sendWith(inviteCache, inviteToSlackConnect, new Date("2026-08-09T00:00:00Z"));

    expect(result.ok).toBe(true);
    expect(inviteToSlackConnect).not.toHaveBeenCalled();
    expect(result.ok && result.payload.body).toContain("https://slack.example/first");
  });

  // Slack's own links go stale, and a stale link is worse than none: the recipient clicks it, is
  // told it is invalid, and has nothing to fall back on.
  it("mints a fresh link once the stored one is older than the window", async () => {
    const inviteCache = cache({
      url: "https://slack.example/stale",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    const inviteToSlackConnect = vi.fn().mockResolvedValue({ url: "https://slack.example/fresh" });
    const result = await sendWith(inviteCache, inviteToSlackConnect, new Date("2026-08-16T00:00:00Z"));

    expect(inviteToSlackConnect).toHaveBeenCalledTimes(1);
    expect(result.ok && result.payload.body).toContain("https://slack.example/fresh");
    // The replacement is what a later send inside the window will now reuse.
    expect(inviteCache.get("ada@example.com", "C0EXAMPLE")).toMatchObject({
      url: "https://slack.example/fresh",
      created_at: "2026-08-16T00:00:00.000Z",
    });
  });

  it("remembers a link it had to mint, so the next send reuses it", async () => {
    const inviteCache = cache();
    const inviteToSlackConnect = vi.fn().mockResolvedValue({ url: "https://slack.example/new" });
    await sendWith(inviteCache, inviteToSlackConnect, new Date("2026-08-01T00:00:00Z"));
    await sendWith(inviteCache, inviteToSlackConnect, new Date("2026-08-05T00:00:00Z"));
    expect(inviteToSlackConnect).toHaveBeenCalledTimes(1);
  });

  // Fourteen days exactly is outside the window: the boundary belongs to the fresh mint, because
  // handing out a link on its expiry day is the case this guard exists to avoid.
  it("treats the fourteenth day as expired", async () => {
    const inviteCache = cache({
      url: "https://slack.example/edge",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    const inviteToSlackConnect = vi.fn().mockResolvedValue({ url: "https://slack.example/fresh" });
    await sendWith(inviteCache, inviteToSlackConnect, new Date("2026-08-15T00:00:00Z"));
    expect(inviteToSlackConnect).toHaveBeenCalledTimes(1);
  });

  it("mints rather than trusting a stored row whose date cannot be read", async () => {
    const inviteCache = cache({ url: "https://slack.example/odd", created_at: "not a date" });
    const inviteToSlackConnect = vi.fn().mockResolvedValue({ url: "https://slack.example/fresh" });
    await sendWith(inviteCache, inviteToSlackConnect, new Date("2026-08-02T00:00:00Z"));
    expect(inviteToSlackConnect).toHaveBeenCalledTimes(1);
  });

  it("still works with no cache wired, minting every time", async () => {
    const inviteToSlackConnect = vi.fn().mockResolvedValue({ url: "https://slack.example/plain" });
    const send = createAdminBotOnboardingSender({
      env: CHANNEL_ENV,
      inviteToSlackConnect,
      sendEmail: vi.fn().mockResolvedValue(undefined),
    });
    await send({ template_id: "alumni", name: "Ada Lovelace", email: "ada@example.com" });
    await send({ template_id: "alumni", name: "Ada Lovelace", email: "ada@example.com" });
    expect(inviteToSlackConnect).toHaveBeenCalledTimes(2);
  });
});
