import { describe, expect, it, vi } from "vitest";
import { ADMINBOT_ONBOARDING_TEMPLATES } from "./onboarding-emails.js";
import { createAdminBotOnboardingSender } from "./onboarding-guide-sender.js";
import {
  composeOnboardingGuide,
  driveWorkspaceFolderName,
  firstNameOf,
  missingGuideValues,
} from "./onboarding-guide.js";

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
        const opensNewBlock = next.trimStart().startsWith("- ");
        const isSignOffOrLabel = line.trimEnd().endsWith(",") || line.trimEnd().endsWith(":");
        const isListItem =
          line.trimStart().startsWith("- ") ||
          line.startsWith("Top ") ||
          line.startsWith("Step ");
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
    const result = composeOnboardingGuide("acquaintance", valuesFor("acquaintance"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.guide.body).not.toMatch(/\{[a-z_]+\}/u);
  });

  // The DCS-address example must survive substitution literally.
  it("leaves the member template's example tokens alone", () => {
    const result = composeOnboardingGuide("member", { first_name: "Ada" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.guide.body).toContain("{first_letter_of_first_name}{full_last_name}");
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
    const send = createAdminBotOnboardingSender({ provisionDriveWorkspace, sendEmail });

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
  });

  it("does not send when provisioning is unavailable", async () => {
    const sendEmail = vi.fn();
    const send = createAdminBotOnboardingSender({ sendEmail });
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
    const send = createAdminBotOnboardingSender({ provisionDriveWorkspace, sendEmail });
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
