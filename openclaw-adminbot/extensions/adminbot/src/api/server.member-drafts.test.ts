import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function start(databasePath?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "adminbot-drafts-"));
  const mock = createAdminBotMockService({
    databasePath,
    serviceToken: "synthetic-service",
    sensitiveInfoPath: path.join(dir, "sensitive.md"),
  });
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const address = mock.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    mock.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function member(id: string) {
    mock.service.upsertLabMember({
      id,
      name: id,
      email: `${id}@cs.toronto.edu`,
      privilege_level: "member",
    });
    await fetch(`${base}/auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member_id: id,
        email: `${id}@cs.toronto.edu`,
        password: "correcthorse",
      }),
    });
    const pending = await (
      await fetch(`${base}/auth/registrations?status=pending`, {
        headers: { Authorization: "Bearer synthetic-service" },
      })
    ).json();
    mock.auth.approveRegistration(
      pending.registrations.find((r: { member_id: string }) => r.member_id === id).id,
      "test-admin",
    );
    const login = await (
      await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@cs.toronto.edu`, password: "correcthorse" }),
      })
    ).json();
    return login.session_token as string;
  }
  const request = (token?: string, body?: unknown, key = "book-meeting") =>
    fetch(`${base}/member-drafts/${key}`, {
      method: body === undefined ? "GET" : "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { mock, base, member, request };
}

describe("private member draft sync", () => {
  it("requires a live member session and isolates owners regardless of payload identity", async () => {
    const lab = await start();
    const ada = await lab.member("ada");
    const bob = await lab.member("bob");
    expect((await lab.request()).status).toBe(401);
    expect((await lab.request("synthetic-service")).status).toBe(403);
    expect(
      (
        await lab.request(ada, {
          baseRevision: 0,
          mutationId: "one",
          memberId: "bob",
          data: { note: "Ada only" },
        })
      ).status,
    ).toBe(200);
    expect((await (await lab.request(bob)).json()).draft).toBeNull();
    expect((await (await lab.request(ada)).json()).draft.data.note).toBe("Ada only");
    await fetch(`${lab.base}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect((await lab.request(ada)).status).toBe(401);
  });
  it("deduplicates retries, rejects stale and altered writes, and keeps a deletion revision", async () => {
    const lab = await start();
    const token = await lab.member("ada");
    const first = { baseRevision: 0, mutationId: "one", data: { note: "first" } };
    expect((await lab.request(token, first)).status).toBe(200);
    expect((await (await lab.request(token, first)).json()).draft.revision).toBe(1);
    expect((await lab.request(token, { ...first, data: { note: "altered" } })).status).toBe(409);
    const race = await Promise.all(
      ["two", "three"].map((mutationId) =>
        lab.request(token, { baseRevision: 1, mutationId, data: { mutationId } }),
      ),
    );
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await lab.request(token, { baseRevision: 2, mutationId: "clear", data: null })).status,
    ).toBe(200);
    expect((await lab.request(token, first)).status).toBe(409);
    expect((await (await lab.request(token)).json()).draft).toMatchObject({
      revision: 3,
      data: null,
    });
    expect(
      (await lab.request(token, { baseRevision: -1, mutationId: "bad", data: null })).status,
    ).toBe(400);
    expect((await lab.request(token, undefined, "arbitrary-command")).status).toBe(404);
  });
});
