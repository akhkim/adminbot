import { afterEach, describe, expect, it, vi } from "vitest";
import { readCachedAdminBotGet } from "../offline/outbox.ts";
import { cacheOfflineMemberSession, fetchMemberSession } from "./session.ts";

afterEach(() => vi.restoreAllMocks());
const session = {
  expires_at: "2099-01-01T00:00:00Z",
  member: { id: "synthetic-member", privilege_level: "member" },
  gateway: { token: "synthetic-gateway-secret" },
};
describe("offline session restoration", () => {
  it("restores an unexpired identity without storing gateway credentials", async () => {
    const token = crypto.randomUUID(),
      base = "https://aurora.test";
    await cacheOfflineMemberSession(token, base, session);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const result = await fetchMemberSession(token, base);
    expect(result).toMatchObject({
      ok: true,
      cached: true,
      value: { member: { id: "synthetic-member" }, gateway: { token: "" } },
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const principalKey = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(
      JSON.stringify(
        await readCachedAdminBotGet({ baseUrl: base, principalKey }, "/offline-identity"),
      ),
    ).not.toContain("synthetic-gateway-secret");
    expect(await fetchMemberSession(token, "https://another.test")).toMatchObject({ ok: false });
  });
  it("refuses expired snapshots and invalidates a snapshot rejected by the server", async () => {
    const token = crypto.randomUUID(),
      base = "https://aurora.test";
    await cacheOfflineMemberSession(token, base, { ...session, expires_at: "2000-01-01" });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    expect(await fetchMemberSession(token, base)).toMatchObject({ ok: false });
    await cacheOfflineMemberSession(token, base, session);
    fetcher.mockResolvedValueOnce(Response.json({ error: "revoked" }, { status: 401 }));
    expect(await fetchMemberSession(token, base)).toMatchObject({ ok: false });
    expect(await fetchMemberSession(token, base)).toMatchObject({ ok: false });
  });
});
