import { afterEach, expect, it, vi } from "vitest";
import { COMPLETE_PROFILE } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

let mock: ReturnType<typeof createAdminBotMockService> | undefined;
afterEach(async () => {
  if (mock) {
    await new Promise<void>((resolve) => mock!.server.close(() => resolve()));
    mock.close();
  }
  vi.restoreAllMocks();
});

it("blocks feature requests, permits only self repair, and unlocks from persisted answers", async () => {
  mock = createAdminBotMockService({ serviceToken: "test-operator" });
  const seeded = mock.service.upsertLabMember({
    ...COMPLETE_PROFILE,
    arr_reviewer_qualified: null,
  });
  expect(seeded.ok).toBe(true);
  if (!seeded.ok) throw new Error(seeded.error.message);
  // Hold the session's original member snapshot to verify the gate re-reads stored answers.
  vi.spyOn(mock.auth, "resolveSession").mockResolvedValue({
    kind: "member",
    member: seeded.payload,
    session: { id: "test-session", member_id: "ada", expires_at: "2099-01-01T00:00:00Z" },
  } as never);
  await new Promise<void>((resolve) => mock!.server.listen(0, "127.0.0.1", resolve));
  const address = mock.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const call = (route: string, method = "GET", body?: object, token = "member-token") =>
    fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect((await call("/lab/members/self")).status).toBe(200);
  const blocked = await call("/papers");
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toMatchObject({
    error: { code: "profile_incomplete", missing_fields: ["arr_reviewer_qualified"] },
  });
  expect((await call("/lab/members/other", "PUT", { location: "Berlin" })).status).toBe(403);
  expect((await call("/papers", "POST", { title: "Blocked" })).status).toBe(403);
  expect((await call("/lab/members/ada", "PUT", { arr_reviewer_qualified: true })).status).toBe(
    200,
  );
  expect((await call("/papers")).status).toBe(403);
  expect((await call("/lab/members/ada", "PUT", { arr_review_capacity: 0 })).status).toBe(200);
  expect((await call("/papers")).status).toBe(200);
  expect((await call("/lab/members/ada", "PUT", { location: "" })).status).toBe(200);
  expect((await call("/papers")).status).toBe(403);
  expect((await call("/papers", "GET", undefined, "test-operator")).status).toBe(200);
  for (const privilege_level of ["external_collaborator", "trial", "admin"] as const) {
    mock.service.upsertLabMember({ id: "ada", privilege_level });
    expect((await call("/papers")).status).toBe(200);
  }
});
