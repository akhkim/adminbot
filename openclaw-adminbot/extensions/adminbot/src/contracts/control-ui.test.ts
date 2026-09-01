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
  // Its own path, not the root. Both reach the same form -- the Control UI is a single-page app and
  // every path rewrites to index.html -- but the root spends a beat as the landing page first, so a
  // member following a reset link watched the marketing page and a sign-in form go by before the
  // form they were sent to appeared. Jordan reported it as the link going to the wrong place.
  it("puts the token on a reset path of its own, not the Control UI root", () => {
    expect(
      buildPasswordResetUrl({
        token: "abc-123",
        controlUiUrl: "https://ui.example.com",
      }),
    ).toBe("https://ui.example.com/reset-password?passwordReset=abc-123");
  });

  // The service host used to travel in the link as `adminBotUrl`. It no longer does: the Control
  // UI already knows which AdminBot it talks to, and the service origin has no business being in
  // a member's inbox.
  it("names the token and nothing else", () => {
    const url = new URL(
      buildPasswordResetUrl({ token: "abc-123", controlUiUrl: "https://ui.example.com" }),
    );
    expect([...url.searchParams.keys()]).toEqual(["passwordReset"]);
    expect(url.searchParams.get("passwordReset")).toBe("abc-123");
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
