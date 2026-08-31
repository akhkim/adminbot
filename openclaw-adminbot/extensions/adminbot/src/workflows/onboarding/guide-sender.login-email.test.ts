// Which address the onboarding guide tells somebody to sign in with.
//
// Two different facts that look like one: the guide is sent to the address a person reads, and
// their portal account is under the governed address on their roster row. For anyone with a CS
// address those differ -- Yann Billeter reads ybilleter@ethz.ch and signs in as
// ybilleter@cs.toronto.edu -- and the copy named the first, so the only way to learn it was wrong
// was a failed sign-in.
import { describe, expect, it } from "vitest";
import { createAdminBotOnboardingSender } from "./guide-sender.js";

function senderWith(
  portalLoginEmail?: (recipient: string) => string | undefined,
) {
  const sent: Array<{ to: string; body: string }> = [];
  const send = createAdminBotOnboardingSender({
    ...(portalLoginEmail ? { portalLoginEmail } : {}),
    provisionDriveWorkspace: async () => ({
      folderId: "folder-1",
      link: "https://drive.google.com/drive/folders/folder-1",
    }),
    inviteToSlackConnect: async () => ({
      url: "https://join.slack.com/share/TEST",
    }),
    sendEmail: async ({ to, body }) => {
      sent.push({ to, body });
    },
  });
  return { send, sent };
}

const request = {
  template_id: "coauthor_major",
  name: "Yann Billeter",
  email: "ybilleter@ethz.ch",
  values: {
    drive_folder_link: "https://drive.google.com/drive/folders/folder-1",
    drive_guide_link: "https://example.test/guide",
    portal_password: "jinesis",
  },
  slack_channel_id: "C0TEST",
};

describe("the address the guide names for signing in", () => {
  it("uses the account address, not the address the mail is going to", async () => {
    const { send, sent } = senderWith((recipient) =>
      recipient === "ybilleter@ethz.ch"
        ? "ybilleter@cs.toronto.edu"
        : undefined,
    );
    const result = await send(request);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sent[0]?.to).toBe("ybilleter@ethz.ch");
    expect(sent[0]?.body).toContain("using ybilleter@cs.toronto.edu");
    expect(sent[0]?.body).not.toContain("using ybilleter@ethz.ch");
  });

  // Somebody whose account is under the address they are written to -- Kem Nguyen-Le is
  // nlpa@umd.edu on both counts -- must read exactly as before.
  it("falls back to the recipient when the roster knows no other address", async () => {
    const { send, sent } = senderWith(() => undefined);
    const result = await send(request);
    expect(result.ok).toBe(true);
    expect(sent[0]?.body).toContain("using ybilleter@ethz.ch");
  });

  // An operator who typed the address in the tab has said what they mean; nothing derived
  // overrides that.
  it("lets an explicit value win over the lookup", async () => {
    const { send, sent } = senderWith(() => "ybilleter@cs.toronto.edu");
    const result = await send({
      ...request,
      values: { ...request.values, member_email: "typed@cs.toronto.edu" },
    });
    expect(result.ok).toBe(true);
    expect(sent[0]?.body).toContain("using typed@cs.toronto.edu");
  });
});
