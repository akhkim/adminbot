import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalChat } from "../privacy/local-chat.js";
import { createAdminBotMockService } from "./server.js";

const running: Array<ReturnType<typeof createAdminBotMockService>> = [];
afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    mock.close();
  }
});
async function setup(localChat?: ReturnType<typeof createLocalChat>) {
  const complete = vi.fn(async () => "synthetic local answer");
  const mock = createAdminBotMockService({
    serviceToken: "synthetic-service-token",
    localChat: localChat ?? { model: "synthetic-local", complete },
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
  });
  running.push(mock);
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const address = mock.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}`;
  const settings = mock.service.updateSettings({ head_professor_member_id: "professor" });
  if (!settings.ok) throw new Error("settings failed");
  const tokens: Record<string, string> = {};
  for (const [id, privilege_level] of [
    ["professor", "admin"],
    ["other-admin", "admin"],
    ["member", "member"],
  ] as const) {
    mock.service.upsertLabMember({
      id,
      name: id,
      email: `${id}@example.test`,
      privilege_level,
      member_type: "full",
    });
    await mock.auth.claim({
      member_id: id,
      email: `${id}@example.test`,
      password: "synthetic-password",
    });
    const registration = (await mock.auth.listRegistrations()).find((row) => row.member_id === id);
    if (!registration) throw new Error("no registration");
    await mock.auth.approveRegistration(registration.id, "synthetic-operator");
    const login = await mock.auth.login({
      email: `${id}@example.test`,
      password: "synthetic-password",
    });
    if (!login.ok) throw new Error("login failed");
    tokens[id] = login.payload.session_token;
  }
  return { mock, url, tokens, complete };
}
const question = { messages: [{ role: "user", content: "Synthetic question" }] };
async function request(url: string, token?: string, body?: unknown) {
  return fetch(`${url}/local-chat`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
describe("Zhijing-only local chat route", () => {
  it("denies anonymous, service-principal and other member/admin access before model calls", async () => {
    const { mock, url, tokens, complete } = await setup();
    for (const token of [
      undefined,
      "synthetic-service-token",
      tokens.member,
      tokens["other-admin"],
    ]) {
      expect((await request(url, token)).status).toBe(token ? 404 : 401);
      expect((await request(url, token, question)).status).toBe(token ? 404 : 401);
    }
    const admin = await mock.auth.resolveSession(tokens["other-admin"]!);
    if (!admin) throw new Error("no admin session");
    const viewed = await mock.auth.startImpersonation({ admin, memberId: "professor" });
    if (!viewed.ok) throw new Error("no impersonation");
    expect((await request(url, viewed.payload.session_token, question)).status).toBe(404);
    await mock.auth.logout(tokens.professor!);
    expect((await request(url, tokens.professor, question)).status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });
  it("serves a local-only answer without storing conversation text", async () => {
    const { mock, url, tokens, complete } = await setup();
    expect(await (await request(url, tokens.professor)).json()).toMatchObject({
      route: "local",
      history: "not_saved",
      tools: false,
    });
    const before = mock.store.listAuditEvents().length;
    expect(await (await request(url, tokens.professor, question)).json()).toEqual({
      output: "synthetic local answer",
      route: "local",
      model: "synthetic-local",
    });
    expect(complete).toHaveBeenCalledWith(question.messages, expect.any(AbortSignal));
    expect(mock.store.listAuditEvents()).toHaveLength(before);
    expect(
      (await request(url, tokens.professor, { messages: [{ role: "system", content: "no" }] }))
        .status,
    ).toBe(400);
    complete.mockRejectedValueOnce(new Error("private data should not be exposed"));
    const failed = await request(url, tokens.professor, question);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private data");
  });

  it("aborts inference when the browser disconnects", async () => {
    let started!: (signal: AbortSignal) => void;
    const start = new Promise<AbortSignal>((resolve) => (started = resolve));
    const { url, tokens } = await setup({
      model: "synthetic-local",
      complete: async (_messages, signal) => {
        started(signal!);
        return await new Promise<string>((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        );
      },
    });
    const controller = new AbortController();
    const call = fetch(`${url}/local-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.professor}` },
      body: JSON.stringify(question),
      signal: controller.signal,
    });
    const rejected = expect(call).rejects.toThrow();
    const signal = await start;
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    controller.abort();
    await rejected;
    await aborted;
    expect(signal.aborted).toBe(true);
  });
  it.skipIf(!process.env.ADMINBOT_TEST_LOCAL_CHAT_URL)(
    "answers through the authenticated route using the real local model",
    async () => {
      const model = "nvidia/Qwen3.5-122B-A10B-NVFP4";
      const { url, tokens } = await setup(
        createLocalChat({
          env: {
            ADMINBOT_LOCAL_BASE_URL: process.env.ADMINBOT_TEST_LOCAL_CHAT_URL,
            ADMINBOT_LOCAL_MODEL: model,
          },
        }),
      );
      const response = await request(url, tokens.professor, {
        messages: [
          { role: "user", content: "Synthetic local-only test. Reply exactly LOCAL_ROUTE_OK_42" },
        ],
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ model, route: "local", output: "LOCAL_ROUTE_OK_42" });
    },
  );
});
