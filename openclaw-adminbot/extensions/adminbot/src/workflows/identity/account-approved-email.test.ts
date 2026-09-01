import { describe, expect, it } from "vitest";
import {
  ACCOUNT_APPROVED_SUBJECT,
  buildAccountApprovedEmailBody,
  createAccountApprovedEmailRunner,
} from "./account-approved-email.js";

describe("account approval email", () => {
  it("sends a gmail with the member's name and the dashboard link", async () => {
    const runs: string[][] = [];
    const send = createAccountApprovedEmailRunner({
      dashboardUrl: "https://lab.example",
      run: async (args) => {
        runs.push(args);
      },
    });

    await send({ email: " ada@example.com ", name: "Ada Author" });

    const args = runs[0]!;
    expect(args.slice(0, 6)).toEqual([
      "--json",
      "--no-input",
      "--enable-commands-exact",
      "gmail.send",
      "gmail",
      "send",
    ]);
    expect(args).not.toContain("--account");
    expect(args[args.indexOf("--to") + 1]).toBe("ada@example.com");
    expect(args[args.indexOf("--subject") + 1]).toBe(ACCOUNT_APPROVED_SUBJECT);
    const body = args[args.indexOf("--body") + 1]!;
    expect(body).toContain("Hi Ada Author,");
    expect(body).toContain("https://lab.example");
  });

  it("greets without a name when the roster record has none", () => {
    expect(buildAccountApprovedEmailBody({ dashboardUrl: "https://lab.example" })).toContain("Hi,");
  });

  it("refuses an empty recipient instead of invoking the CLI", async () => {
    const runs: string[][] = [];
    const send = createAccountApprovedEmailRunner({
      run: async (args) => {
        runs.push(args);
      },
    });

    await expect(send({ email: "   " })).rejects.toThrow(/non-empty email/u);
    expect(runs).toEqual([]);
  });

  it("pins the sending mailbox when GOG_ACCOUNT is set", async () => {
    const runs: string[][] = [];
    const send = createAccountApprovedEmailRunner({
      env: { GOG_ACCOUNT: "lab.adminbot@example.com" } as NodeJS.ProcessEnv,
      run: async (args) => {
        runs.push(args);
      },
    });

    await send({ email: "pat@example.com" });

    expect(runs[0]![runs[0]!.indexOf("--account") + 1]).toBe("lab.adminbot@example.com");
  });

  it("prefers the configured dashboard url over the environment default", async () => {
    const runs: string[][] = [];
    const send = createAccountApprovedEmailRunner({
      env: { ADMINBOT_DASHBOARD_URL: "https://from-env.example" } as NodeJS.ProcessEnv,
      run: async (args) => {
        runs.push(args);
      },
    });

    await send({ email: "pat@example.com" });

    expect(runs[0]![runs[0]!.indexOf("--body") + 1]).toContain("https://from-env.example");
  });

  it("uses the canonical Control UI environment variable in approval links", async () => {
    const runs: string[][] = [];
    const send = createAccountApprovedEmailRunner({
      env: { ADMINBOT_CONTROL_UI_URL: "https://control.example/" } as NodeJS.ProcessEnv,
      run: async (args) => {
        runs.push(args);
      },
    });

    await send({ email: "ada@example.com" });

    expect(runs[0]![runs[0]!.indexOf("--body") + 1]).toContain("https://control.example");
  });
});
