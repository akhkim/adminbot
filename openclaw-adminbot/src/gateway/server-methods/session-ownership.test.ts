/**
 * Tests per-member session ownership resolution and access checks.
 */
import { describe, expect, it } from "vitest";
import {
  canRequesterAccessSession,
  resolveSessionAccessRequester,
} from "./session-ownership.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import type { GatewayClient } from "./shared-types.js";

function createClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    connect: { scopes: [], device: undefined } as unknown as GatewayClient["connect"],
    ...overrides,
  };
}

describe("resolveSessionAccessRequester", () => {
  it("resolves memberId from client.ownerMemberId and isAdmin from scopes", () => {
    const requester = resolveSessionAccessRequester(
      createClient({
        ownerMemberId: "mem-1",
        connect: { scopes: [ADMIN_SCOPE] } as unknown as GatewayClient["connect"],
      }),
    );
    expect(requester).toEqual({ memberId: "mem-1", isAdmin: true });
  });

  it("treats a null client as an unscoped, non-admin requester", () => {
    expect(resolveSessionAccessRequester(null)).toEqual({ memberId: undefined, isAdmin: false });
  });

  it("leaves memberId undefined for a connection with no paired-device identity", () => {
    const requester = resolveSessionAccessRequester(createClient());
    expect(requester.memberId).toBeUndefined();
    expect(requester.isAdmin).toBe(false);
  });
});

describe("canRequesterAccessSession", () => {
  it("allows an admin requester regardless of ownership", () => {
    expect(
      canRequesterAccessSession(
        { ownerMemberId: "mem-1" },
        { memberId: "mem-2", isAdmin: true },
      ),
    ).toBe(true);
  });

  it("allows access to a session with no recorded owner (unscoped fallback)", () => {
    expect(canRequesterAccessSession({ ownerMemberId: undefined }, { isAdmin: false })).toBe(
      true,
    );
  });

  it("allows the owning member", () => {
    expect(
      canRequesterAccessSession(
        { ownerMemberId: "mem-1" },
        { memberId: "mem-1", isAdmin: false },
      ),
    ).toBe(true);
  });

  it("denies a different member", () => {
    expect(
      canRequesterAccessSession(
        { ownerMemberId: "mem-1" },
        { memberId: "mem-2", isAdmin: false },
      ),
    ).toBe(false);
  });

  it("denies a requester with no member identity when the session is owned", () => {
    expect(
      canRequesterAccessSession({ ownerMemberId: "mem-1" }, { memberId: undefined, isAdmin: false }),
    ).toBe(false);
  });
});
