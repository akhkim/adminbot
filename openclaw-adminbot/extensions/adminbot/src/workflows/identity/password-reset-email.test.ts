import { describe, expect, it } from "vitest";
import { createPasswordResetEmailRunner, PASSWORD_RESET_SUBJECT } from "./password-reset-email.js";

async function captureArgs(env: Record<string, string>): Promise<string[]> {
  let captured: string[] = [];
  const runner = createPasswordResetEmailRunner({
    env: env as NodeJS.ProcessEnv,
    run: async (args) => {
      captured = args;
    },
  });
  await runner({
    email: "member@example.edu",
    name: "Ada",
    token: "tok-1",
    expiresInMinutes: 60,
  });
  return captured;
}

function resetUrlFrom(args: string[]): URL {
  const body = args[args.indexOf("--body") + 1] ?? "";
  const match = body.match(/https?:\/\/\S+/);
  expect(match).not.toBeNull();
  return new URL(match?.[0] ?? "");
}

describe("createPasswordResetEmailRunner", () => {
  it("mails the token to the address on the credential", async () => {
    const args = await captureArgs({
      ADMINBOT_CONTROL_UI_URL: "https://ui.example.com",
    });
    expect(args[args.indexOf("--to") + 1]).toBe("member@example.edu");
    expect(args[args.indexOf("--subject") + 1]).toBe(PASSWORD_RESET_SUBJECT);
  });

  // The whole point of the link: the built-in console at the service origin cannot redeem a token,
  // so the link has to name the Control UI even when the service is reachable publicly.
  it("points the link at the Control UI, not at the service origin", async () => {
    const url = resetUrlFrom(
      await captureArgs({
        ADMINBOT_CONTROL_UI_URL: "https://ui.example.com",
        ADMINBOT_PUBLIC_URL: "https://admin.example.com",
      }),
    );
    expect(url.origin).toBe("https://ui.example.com");
    expect(url.searchParams.get("passwordReset")).toBe("tok-1");
    // ...and tells that Control UI which AdminBot minted the token.
    expect(url.searchParams.get("adminBotUrl")).toBe("https://admin.example.com");
  });

  it("omits adminBotUrl when the deployment publishes no public service origin", async () => {
    const url = resetUrlFrom(
      await captureArgs({ ADMINBOT_CONTROL_UI_URL: "https://ui.example.com" }),
    );
    expect(url.searchParams.has("adminBotUrl")).toBe(false);
  });

  it("refuses an empty recipient rather than mailing nobody", async () => {
    const runner = createPasswordResetEmailRunner({
      env: {} as NodeJS.ProcessEnv,
      run: async () => undefined,
    });
    await expect(runner({ email: "   ", token: "tok-1", expiresInMinutes: 60 })).rejects.toThrow(
      /non-empty email/,
    );
  });
});
