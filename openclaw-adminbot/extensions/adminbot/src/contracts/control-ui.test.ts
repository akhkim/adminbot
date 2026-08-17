import { describe, expect, it } from "vitest";
import {
  buildPasswordResetUrl,
  DEFAULT_ADMINBOT_CONTROL_UI_URL,
  resolveAdminBotControlUiUrl,
} from "./control-ui.js";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe("resolveAdminBotControlUiUrl", () => {
  it("prefers the explicit Control UI origin", () => {
    expect(
      resolveAdminBotControlUiUrl(
        env({
          ADMINBOT_CONTROL_UI_URL: "https://ui.example.com/",
          ADMINBOT_DASHBOARD_URL: "https://admin.example.com",
        }),
      ),
    ).toBe("https://ui.example.com");
  });

  it("falls back to the older dashboard variable", () => {
    expect(
      resolveAdminBotControlUiUrl(env({ ADMINBOT_DASHBOARD_URL: "https://ui.example.com" })),
    ).toBe("https://ui.example.com");
  });

  it("falls back to the built-in default when neither is set", () => {
    expect(resolveAdminBotControlUiUrl(env({}))).toBe(DEFAULT_ADMINBOT_CONTROL_UI_URL);
    // Blank is the same as unset: an operator clearing the value must not produce a "/…" link.
    expect(resolveAdminBotControlUiUrl(env({ ADMINBOT_CONTROL_UI_URL: "   " }))).toBe(
      DEFAULT_ADMINBOT_CONTROL_UI_URL,
    );
  });
});

describe("buildPasswordResetUrl", () => {
  it("puts the token on the Control UI root, where the confirm step lives", () => {
    expect(
      buildPasswordResetUrl({
        token: "abc-123",
        controlUiUrl: "https://ui.example.com",
      }),
    ).toBe("https://ui.example.com/?passwordReset=abc-123");
  });

  it("pins the AdminBot the token was minted against when one is published", () => {
    const url = new URL(
      buildPasswordResetUrl({
        token: "abc-123",
        controlUiUrl: "https://ui.example.com",
        adminBotUrl: "https://admin.example.com/",
      }),
    );
    expect(url.searchParams.get("passwordReset")).toBe("abc-123");
    expect(url.searchParams.get("adminBotUrl")).toBe("https://admin.example.com");
  });

  it("escapes a token that would otherwise break the query string", () => {
    const url = new URL(
      buildPasswordResetUrl({
        token: "a+b/c=&d",
        controlUiUrl: "https://ui.example.com",
      }),
    );
    expect(url.searchParams.get("passwordReset")).toBe("a+b/c=&d");
  });
});
