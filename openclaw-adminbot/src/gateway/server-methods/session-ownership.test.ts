/**
 * Tests per-member session ownership resolution and access checks.
 *
 * The rule under test is deliberately absolute: a session is readable by the member who owns it
 * and by nobody else. There is no admin bypass, and an unowned session is unreachable rather than
 * public. Both halves fail closed, so most of this file is about what is *denied*.
 */
import { describe, expect, it } from "vitest";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  canRequesterAccessSession,
  resolveSessionAccessRequester,
  resolveSessionOwnerMemberId,
} from "./session-ownership.js";
import type { GatewayClient } from "./shared-types.js";

function createClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    connect: { scopes: [], device: undefined } as unknown as GatewayClient["connect"],
    ...overrides,
  };
}

describe("resolveSessionAccessRequester", () => {
  it("resolves memberId from client.ownerMemberId", () => {
    const requester = resolveSessionAccessRequester(createClient({ ownerMemberId: "mem-1" }));
    expect(requester).toEqual({ memberId: "mem-1" });
  });

  // The admin scope is not consulted at all: it used to become an `isAdmin` bypass, and the
  // requester shape no longer carries one so it cannot quietly come back.
  it("ignores the admin scope entirely", () => {
    const requester = resolveSessionAccessRequester(
      createClient({
        ownerMemberId: "mem-1",
        connect: { scopes: [ADMIN_SCOPE] } as unknown as GatewayClient["connect"],
      }),
    );
    expect(requester).toEqual({ memberId: "mem-1" });
  });

  it("treats a null client as having no identity", () => {
    expect(resolveSessionAccessRequester(null)).toEqual({ memberId: undefined });
  });

  it("leaves memberId undefined for a connection with no paired-device identity", () => {
    expect(resolveSessionAccessRequester(createClient()).memberId).toBeUndefined();
  });
});

describe("canRequesterAccessSession", () => {
  it("allows the owning member", () => {
    expect(canRequesterAccessSession({ ownerMemberId: "mem-1" }, { memberId: "mem-1" })).toBe(true);
  });

  it("denies a different member", () => {
    expect(canRequesterAccessSession({ ownerMemberId: "mem-1" }, { memberId: "mem-2" })).toBe(
      false,
    );
  });

  // An admin governs the lab; that is not the same as reading what someone typed into a private
  // chat. Holding the admin scope buys nothing here.
  it("denies an admin who is not the owner", () => {
    const adminRequester = resolveSessionAccessRequester(
      createClient({
        ownerMemberId: "mem-2",
        connect: { scopes: [ADMIN_SCOPE] } as unknown as GatewayClient["connect"],
      }),
    );
    expect(canRequesterAccessSession({ ownerMemberId: "mem-1" }, adminRequester)).toBe(false);
  });

  // Unowned means unreachable, not public. Creation refuses without an identity to stamp, so a
  // session with no owner is a pre-ownership leftover or a bug -- either way it stays shut.
  it("denies everyone on a session with no recorded owner", () => {
    expect(canRequesterAccessSession({ ownerMemberId: undefined }, { memberId: "mem-1" })).toBe(
      false,
    );
    expect(canRequesterAccessSession({ ownerMemberId: undefined }, { memberId: undefined })).toBe(
      false,
    );
  });

  it("denies a requester with no member identity", () => {
    expect(canRequesterAccessSession({ ownerMemberId: "mem-1" }, { memberId: undefined })).toBe(
      false,
    );
  });

  it("treats a blank owner or requester id as absent", () => {
    expect(canRequesterAccessSession({ ownerMemberId: "   " }, { memberId: "mem-1" })).toBe(false);
    expect(canRequesterAccessSession({ ownerMemberId: "mem-1" }, { memberId: "   " })).toBe(false);
  });
});

// Ownership is derived from the session key, not only from the stamp. This is what lets a session
// created by auto-reply, cron or an agent tool be correctly owned without any of those paths
// knowing about ownership or carrying an identity down to the store write.
describe("ownership derived from the session key", () => {
  it("treats a member-keyed session as owned by that member, with no stamp at all", () => {
    expect(resolveSessionOwnerMemberId({}, "agent:main:member-ada")).toBe("ada");
    expect(canRequesterAccessSession({}, { memberId: "ada" }, "agent:main:member-ada")).toBe(true);
    expect(canRequesterAccessSession({}, { memberId: "bo" }, "agent:main:member-ada")).toBe(false);
  });

  // The shared main slot, a cron run, an operator's named session: nobody's to read through the
  // member-facing gateway.
  it("leaves a session with no member in its key owned by nobody", () => {
    for (const key of ["agent:main:main", "agent:main:cron-nightly", "global"]) {
      expect(resolveSessionOwnerMemberId({}, key)).toBeUndefined();
      expect(canRequesterAccessSession({}, { memberId: "ada" }, key)).toBe(false);
    }
  });

  // A stamp is the authority when both exist -- a session explicitly recorded as someone's does
  // not change hands because it happens to sit at another key.
  it("prefers an explicit stamp over the key", () => {
    expect(resolveSessionOwnerMemberId({ ownerMemberId: "bo" }, "agent:main:member-ada")).toBe(
      "bo",
    );
    expect(
      canRequesterAccessSession(
        { ownerMemberId: "bo" },
        { memberId: "ada" },
        "agent:main:member-ada",
      ),
    ).toBe(false);
  });

  it("still denies when neither the stamp nor the key names an owner", () => {
    expect(canRequesterAccessSession({}, { memberId: "ada" })).toBe(false);
  });
});
