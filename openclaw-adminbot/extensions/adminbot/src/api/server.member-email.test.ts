// POST /lab/members/:id/email -- an admin moving the address a member signs in with. What matters:
// the sign-in and the roster copy move together, the old address stops working, a reset link sent
// to the old address dies with it, and the password-free route cannot be used on the caller's own
// account, the PI's, or by anyone who is not an admin at the keyboard.
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const PASSWORD = "correcthorse";

const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop();
    if (!mock) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
});

type Store = {
  getLabMember: (id: string) => AdminBotLabMember | undefined;
  getCredentialByMemberId: (id: string) => { email: string } | undefined;
  listAuditEvents: () => Array<{ type: string; actor?: string; details?: Record<string, unknown> }>;
};

const jsonHeaders = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  ...extra,
});

async function lab() {
  // The reset mail is the only place a reset token goes, so the test collects it here.
  const resetMail: Array<{ email: string; token: string }> = [];
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    passwordResetEmailRunner: async ({ email, token }) => {
      resetMail.push({ email, token });
    },
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", () => {
      mock.server.off("error", reject);
      resolve();
    });
  });
  running.push(mock);
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const store = (mock.service as never as { store: Store }).store;
  const seed = (input: AdminBotLabMemberInput) => {
    const result = mock.service.upsertLabMember(withCompleteProfile(input));
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  };
  const loginRaw = (email: string) =>
    fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });
  const claim = async (memberId: string, email: string) => {
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ member_id: memberId, email, password: PASSWORD }),
    });
    const pending = (await (
      await fetch(`${baseUrl}/auth/registrations?status=pending`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
      })
    ).json()) as { registrations: Array<{ id: string; member_id?: string }> };
    const registration = pending.registrations.find((entry) => entry.member_id === memberId);
    if (!registration) {
      throw new Error(`no pending registration for ${memberId}`);
    }
    const approved = await mock.auth.approveRegistration(registration.id, "seed-admin");
    if (!approved.ok) {
      throw new Error(approved.error.message);
    }
    const res = await loginRaw(email);
    return ((await res.json()) as { session_token: string }).session_token;
  };
  seed({ id: "admin", name: "Admin", email: "admin@cs.toronto.edu", privilege_level: "admin" });
  seed({ id: "pi", name: "Pi", email: "pi@cs.toronto.edu", privilege_level: "admin" });
  seed({ id: "ada", name: "Ada", email: "ada@cs.toronto.edu", privilege_level: "member" });
  seed({ id: "bo", name: "Bo", email: "bo@cs.toronto.edu", privilege_level: "member" });
  // On the roster but never claimed an account.
  seed({ id: "cy", name: "Cy", email: "cy@cs.toronto.edu", privilege_level: "member" });
  const admin = await claim("admin", "admin@cs.toronto.edu");
  await claim("pi", "pi@cs.toronto.edu");
  const ada = await claim("ada", "ada@cs.toronto.edu");
  await claim("bo", "bo@cs.toronto.edu");
  mock.service.updateSettings({ head_professor_member_id: "pi" });
  const change = (token: string | undefined, memberId: string, newEmail: unknown) =>
    fetch(`${baseUrl}/lab/members/${encodeURIComponent(memberId)}/email`, {
      method: "POST",
      headers: jsonHeaders(token ? { Authorization: `Bearer ${token}` } : {}),
      body: JSON.stringify({ new_email: newEmail }),
    });
  return { baseUrl, mock, store, admin, ada, change, loginRaw, resetMail };
}

describe("an admin changing a member's sign-in email", () => {
  it("moves the sign-in and the roster email together, and the old address stops working", async () => {
    const { store, admin, change, loginRaw } = await lab();
    const res = await change(admin, "ada", "  Ada.New@Example.ORG ");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      email: "ada.new@example.org",
      previous_email: "ada@cs.toronto.edu",
      had_sign_in: true,
    });
    expect(store.getCredentialByMemberId("ada")?.email).toBe("ada.new@example.org");
    expect(store.getLabMember("ada")?.email).toBe("ada.new@example.org");
    expect((await loginRaw("ada@cs.toronto.edu")).status).toBe(401);
    expect((await loginRaw("ada.new@example.org")).status).toBe(200);
    const audit = store
      .listAuditEvents()
      .filter((e) => e.type === "lab_member.login_email_changed");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: "admin",
      details: {
        member_id: "ada",
        from_email: "ada@cs.toronto.edu",
        to_email: "ada.new@example.org",
        had_sign_in: true,
      },
    });
  });

  // The link went to an inbox the admin has just judged to be the wrong one.
  it("kills a password-reset link already sent to the old address", async () => {
    const { baseUrl, admin, change, loginRaw, resetMail } = await lab();
    const requested = await fetch(`${baseUrl}/auth/password-reset`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "ada@cs.toronto.edu" }),
    });
    expect(requested.status).toBe(200);
    // The mail is sent after the response; give it the turn it needs.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    const sent = resetMail.find((mail) => mail.email === "ada@cs.toronto.edu");
    expect(sent?.token).toBeTruthy();

    expect((await change(admin, "ada", "ada.new@example.org")).status).toBe(200);

    const redeemed = await fetch(`${baseUrl}/auth/password-reset/confirm`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ token: sent!.token, new_password: "anotherhorse2" }),
    });
    expect(redeemed.status).toBe(400);
    // And the password the link would have replaced still works at the new address.
    expect((await loginRaw("ada.new@example.org")).status).toBe(200);
  });

  it("changes only the roster email of a member who has not claimed an account", async () => {
    const { store, admin, change } = await lab();
    const res = await change(admin, "cy", "cy@example.org");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "cy@example.org", had_sign_in: false });
    expect(store.getLabMember("cy")?.email).toBe("cy@example.org");
    expect(store.getCredentialByMemberId("cy")).toBeUndefined();
  });

  it("is an admin's call, made in an admin session", async () => {
    const { store, ada, change } = await lab();
    expect((await change(ada, "bo", "bo@example.org")).status).toBe(403);
    expect((await change(SERVICE_TOKEN, "bo", "bo@example.org")).status).toBe(403);
    expect((await change(undefined, "bo", "bo@example.org")).status).toBe(401);
    expect(store.getCredentialByMemberId("bo")?.email).toBe("bo@cs.toronto.edu");
  });

  // This route skips the password, so it is for someone else's account, never the PI's.
  it("refuses the caller's own account and the head professor's", async () => {
    const { store, admin, change } = await lab();
    const self = await change(admin, "admin", "admin@example.org");
    expect(self.status).toBe(403);
    expect(((await self.json()) as { error: { message: string } }).error.message).toMatch(
      /My Profile/u,
    );
    expect((await change(admin, "pi", "pi@example.org")).status).toBe(403);
    expect(store.getCredentialByMemberId("pi")?.email).toBe("pi@cs.toronto.edu");
  });

  it("refuses a malformed, unchanged or taken address and leaves the sign-in where it was", async () => {
    const { baseUrl, store, admin, change } = await lab();
    const signup = await fetch(`${baseUrl}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        profile: { name: "Applicant", research_branch: "Systems" },
        email: "applicant@example.org",
        password: PASSWORD,
      }),
    });
    expect(await signup.json()).toEqual({ status: "pending" });
    const cases: Array<[unknown, number]> = [
      ["not-an-email", 400],
      ["", 400],
      ["ADA@cs.toronto.edu", 400],
      // Another member's sign-in.
      ["bo@cs.toronto.edu", 409],
      // On the roster for a member who never signed in.
      ["cy@cs.toronto.edu", 409],
    ];
    for (const [email, status] of cases) {
      const res = await change(admin, "ada", email);
      expect([email, res.status]).toEqual([email, status]);
    }
    // Somebody's pending sign-up: approving it would then collide with Ada's sign-in.
    expect((await change(admin, "ada", "applicant@example.org")).status).toBe(409);
    expect((await change(admin, "nobody", "x@example.org")).status).toBe(404);
    expect(store.getCredentialByMemberId("ada")?.email).toBe("ada@cs.toronto.edu");
    expect(store.getLabMember("ada")?.email).toBe("ada@cs.toronto.edu");
  });
});
