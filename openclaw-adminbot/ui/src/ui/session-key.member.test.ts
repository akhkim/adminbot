// @vitest-environment node
/**
 * Per-member session keys.
 *
 * Every member used to land on the same `agent:<agentId>:main`, so the lab shared one
 * conversation. These helpers give each member their own slot, which is what makes per-session
 * ownership mean anything -- marking who owns a session is pointless while everyone points at the
 * same one.
 */
import { describe, expect, it } from "vitest";
import {
  buildMemberSessionKey,
  isForeignMemberSessionKey,
  isMemberSessionKey,
  memberIdFromSessionKey,
  parseAgentSessionKey,
} from "./session-key.ts";

describe("buildMemberSessionKey", () => {
  it("gives each member their own slot under the same agent", () => {
    expect(buildMemberSessionKey({ agentId: "main", memberId: "ada" })).toBe(
      "agent:main:member-ada",
    );
    expect(buildMemberSessionKey({ agentId: "main", memberId: "bo" })).toBe("agent:main:member-bo");
  });

  // A member id is whatever the roster assigned -- it must not be able to produce a key the
  // grammar cannot parse, or the session becomes unreachable rather than private.
  it("normalizes an id that would otherwise break the key grammar", () => {
    const key = buildMemberSessionKey({ agentId: "main", memberId: "Ada Lovelace!" });
    expect(parseAgentSessionKey(key)).not.toBeNull();
    expect(key).toBe("agent:main:member-ada-lovelace");
  });

  it("keeps the agent dimension", () => {
    expect(buildMemberSessionKey({ agentId: "ops", memberId: "ada" })).toBe("agent:ops:member-ada");
  });
});

describe("memberIdFromSessionKey", () => {
  it("reads the owner back out", () => {
    expect(memberIdFromSessionKey("agent:main:member-ada")).toBe("ada");
    expect(isMemberSessionKey("agent:main:member-ada")).toBe(true);
  });

  // The shared main slot and an operator's named session are not member sessions, and must not be
  // mistaken for one -- otherwise the guard below would treat them as somebody else's.
  it("returns nothing for a session that is not a member's", () => {
    for (const key of ["agent:main:main", "agent:main:scratch", "global", "", undefined]) {
      expect(memberIdFromSessionKey(key)).toBeUndefined();
      expect(isMemberSessionKey(key)).toBe(false);
    }
  });
});

describe("isForeignMemberSessionKey", () => {
  // The selected key is persisted per gateway URL, not per member, so a shared browser would hand
  // the next person to sign in the previous member's chat.
  it("flags another member's session", () => {
    expect(isForeignMemberSessionKey("agent:main:member-ada", "bo")).toBe(true);
  });

  it("does not flag your own", () => {
    expect(isForeignMemberSessionKey("agent:main:member-ada", "ada")).toBe(false);
    expect(isForeignMemberSessionKey("agent:main:member-ada", "Ada")).toBe(false);
  });

  // A signed-out viewer has no session of their own to be sent to, but must still not inherit one.
  it("flags a member session when nobody is signed in", () => {
    expect(isForeignMemberSessionKey("agent:main:member-ada", null)).toBe(true);
    expect(isForeignMemberSessionKey("agent:main:member-ada", "")).toBe(true);
  });

  it("leaves shared and operator sessions alone", () => {
    expect(isForeignMemberSessionKey("agent:main:main", "ada")).toBe(false);
    expect(isForeignMemberSessionKey("agent:ops:scratch", "ada")).toBe(false);
    expect(isForeignMemberSessionKey(undefined, "ada")).toBe(false);
  });
});
