import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  createSessionCookie,
  readSessionCookie,
} from "./session-cookie.js";

const TOKEN = "a".repeat(43);

describe("session cookie transport", () => {
  it("creates an HTTP-only strict cookie without exposing a domain", () => {
    expect(createSessionCookie(TOKEN, 3_600, { secure: true })).toBe(
      `adminbot_session_v1=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure`,
    );
    expect(clearSessionCookie({ secure: false })).toBe(
      "adminbot_session_v1=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    );
  });

  it("reads only one well-formed session token and fails closed on ambiguity", () => {
    expect(readSessionCookie(`theme=dark; adminbot_session_v1=${TOKEN}; other=x`)).toBe(TOKEN);
    expect(
      readSessionCookie(`adminbot_session_v1=${TOKEN}; adminbot_session_v1=${TOKEN}`),
    ).toBeUndefined();
    expect(readSessionCookie("adminbot_session_v1=../../secret")).toBeUndefined();
  });
});
