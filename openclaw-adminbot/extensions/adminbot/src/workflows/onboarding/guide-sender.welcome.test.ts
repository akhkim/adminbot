import { describe, expect, it, vi } from "vitest";
import { createAdminBotOnboardingSender } from "./guide-sender.js";

describe("the basic welcome", () => {
  it("sends without Slack, Drive, calendar or DCS provisioning configured", async () => {
    const sendEmail = vi.fn(async (_message: { to: string; subject: string; body: string }) => {});
    const sender = createAdminBotOnboardingSender({
      env: { ADMINBOT_CONTACT_EMAILS: "help@lab.example" },
      sendEmail,
    });
    const result = await sender({
      template_id: "welcome",
      name: "Ada Lovelace",
      email: "ada@example.org",
    });

    expect(result.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.org",
        subject: "Getting connected with the Jinesis Lab",
        body: expect.stringContaining("help@lab.example"),
        reply_to: "help@lab.example",
      }),
    );
    const body = sendEmail.mock.calls[0]?.[0];
    expect(body?.body).not.toMatch(/\{[a-z_]+\}/u);
    expect(body?.body).not.toContain("password");
  });

  it("does not send a welcome with a missing contact address", async () => {
    const sendEmail = vi.fn(async () => {});
    const sender = createAdminBotOnboardingSender({ env: {}, sendEmail });
    const result = await sender({
      template_id: "welcome",
      name: "Ada Lovelace",
      email: "ada@example.org",
    });
    expect(result.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
