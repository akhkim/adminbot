// The full-member welcome and its catch-up mail: both have to arrive with the member's 1:1 Drive
// folder and the guidebook link.
//
// For a while the member welcome carried neither. guide-sender provisions the folder from what the
// outgoing copy asks for, so with no {drive_folder_link} in it no member got a folder -- and the
// portal's onboarding step went on telling them one had been shared. These tests pin the copy and
// the provisioning together, so the two cannot drift apart silently again.
import { describe, expect, it, vi } from "vitest";
import { findOnboardingTemplate } from "./emails.js";
import { createAdminBotOnboardingSender } from "./guide-sender.js";

const GUIDEBOOK =
  "https://docs.google.com/document/d/1H9Bt4z9uvDtieujh8Wp9YXDeLDhkq7vsKYGUvPnktN8/edit";

// Built here rather than inherited, so the result does not depend on whose machine runs it.
const ENV = {
  ADMINBOT_SLACK_INVITE_URL: "https://join.slack.com/t/jinesis/shared_invite/test",
  ADMINBOT_CONTACT_EMAILS: "lab-admin@example.test",
  ADMINBOT_BOT_EMAIL: "adminbot@example.test",
} as NodeJS.ProcessEnv;

function sender(env: NodeJS.ProcessEnv = ENV) {
  const provisionDriveWorkspace = vi
    .fn()
    .mockResolvedValue({ folderId: "fld", link: "https://drive.example/fld" });
  const sendEmail = vi.fn().mockResolvedValue(undefined);
  const send = createAdminBotOnboardingSender({ env, provisionDriveWorkspace, sendEmail });
  return { send, provisionDriveWorkspace, sendEmail };
}

describe("the full-member welcome", () => {
  it("asks for the Drive folder and the guidebook in its own copy", () => {
    const body = findOnboardingTemplate("member")?.body ?? "";
    expect(body).toContain("{drive_folder_link}");
    expect(body).toContain("{guidebook_link}");
  });

  it("provisions the member's folder with the lab's contents and links both", async () => {
    const { send, provisionDriveWorkspace, sendEmail } = sender();

    const result = await send({
      template_id: "member",
      name: "Ada Lovelace",
      email: "ada@example.test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(provisionDriveWorkspace).toHaveBeenCalledWith({
      folderName: "Zhijing-AdaLovelace",
      includeContents: true,
    });
    expect(result.payload.body).toContain("https://drive.example/fld");
    expect(result.payload.body).toContain(GUIDEBOOK);
    expect(result.payload.body).not.toContain("{drive_folder_link}");
    expect(result.payload.body).not.toContain("{guidebook_link}");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("the Drive-folder catch-up mail", () => {
  it("provisions the same full-member folder and links it with the guidebook", async () => {
    const { send, provisionDriveWorkspace } = sender();

    const result = await send({
      template_id: "member_drive_folder",
      name: "Ada Lovelace",
      email: "ada@example.test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Same name as the welcome's, so the provisioner finds the folder a welcome already made.
    expect(provisionDriveWorkspace).toHaveBeenCalledWith({
      folderName: "Zhijing-AdaLovelace",
      includeContents: true,
    });
    expect(result.payload.subject).toBe("Your Jinesis Drive folder and the lab guidebook");
    expect(result.payload.body).toContain("https://drive.example/fld");
    expect(result.payload.body).toContain(GUIDEBOOK);
  });

  it("uses the configured guidebook address when the deployment sets one", async () => {
    const { send } = sender({
      ...ENV,
      ADMINBOT_GUIDEBOOK_URL: "https://docs.google.com/document/d/synthetic-guidebook/edit",
    });

    const result = await send({
      template_id: "member_drive_folder",
      name: "Ada Lovelace",
      email: "ada@example.test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.body).toContain(
      "https://docs.google.com/document/d/synthetic-guidebook/edit",
    );
    expect(result.payload.body).not.toContain(GUIDEBOOK);
  });
});
