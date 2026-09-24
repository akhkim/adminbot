import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { createMemoryFailedRequestLedger } from "../persistence/failed-requests.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-ops-service-token";

type Running = {
  mock: ReturnType<typeof createAdminBotMockService>;
};

const running: Running[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
  }
});

async function startService(
  options: Parameters<typeof createAdminBotMockService>[0] = {},
): Promise<{ baseUrl: string; mock: ReturnType<typeof createAdminBotMockService> }> {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    ...options,
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", () => {
      mock.server.off("error", reject);
      resolve();
    });
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  running.push({ mock });
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

async function memberSession(baseUrl: string, mock: ReturnType<typeof createAdminBotMockService>) {
  const seeded = mock.service.upsertLabMember({
    id: "ada",
    name: "Ada",
    email: "ada@cs.toronto.edu",
    privilege_level: "member",
  } as AdminBotLabMemberInput);
  if (!seeded.ok) {
    throw new Error(seeded.error.message);
  }
  const claim = await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      member_id: "ada",
      email: "ada@cs.toronto.edu",
      password: "correcthorse",
    }),
  });
  expect(claim.status).toBe(200);
  const pending = await (
    await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    })
  ).json();
  const registration = (pending as { registrations: Array<{ id: string; member_id?: string }> })
    .registrations.find((entry) => entry.member_id === "ada");
  if (!registration) {
    throw new Error("missing claim registration");
  }
  const approved = mock.auth.approveRegistration(registration.id, "test-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ada@cs.toronto.edu", password: "correcthorse" }),
  });
  expect(login.status).toBe(200);
  return ((await login.json()) as { session_token: string }).session_token;
}

describe("GET /ops/llm-load and /ops/failed-requests", () => {
  it("refuses both routes without a session", async () => {
    const { baseUrl } = await startService();
    const load = await fetch(`${baseUrl}/ops/llm-load`);
    const failed = await fetch(`${baseUrl}/ops/failed-requests`);
    expect(load.status).toBe(401);
    expect(failed.status).toBe(401);
  });

  it("returns live slot counts to the service principal", async () => {
    const { baseUrl } = await startService();
    const response = await fetch(`${baseUrl}/ops/llm-load`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      local_active: 0,
      public_active: 0,
      queued: 0,
      max_local: 8,
      max_public: 100,
    });
  });

  it("lets a signed-in member read load, but not the failure ledger", async () => {
    const { baseUrl, mock } = await startService();
    const token = await memberSession(baseUrl, mock);
    const load = await fetch(`${baseUrl}/ops/llm-load`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const failed = await fetch(`${baseUrl}/ops/failed-requests`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(load.status).toBe(200);
    expect(failed.status).toBe(403);
  });

  it("returns 502 when the shared gateway is configured but unreachable", async () => {
    const previousUrl = process.env.LLM_GATEWAY_URL;
    const previousToken = process.env.LLM_GATEWAY_TOKEN;
    process.env.LLM_GATEWAY_URL = "http://127.0.0.1:1";
    process.env.LLM_GATEWAY_TOKEN = "synthetic-gateway-token";
    try {
      const { baseUrl } = await startService();
      const response = await fetch(`${baseUrl}/ops/llm-load`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: { message: "shared LLM gateway is unreachable" },
      });
    } finally {
      if (previousUrl === undefined) {
        delete process.env.LLM_GATEWAY_URL;
      } else {
        process.env.LLM_GATEWAY_URL = previousUrl;
      }
      if (previousToken === undefined) {
        delete process.env.LLM_GATEWAY_TOKEN;
      } else {
        process.env.LLM_GATEWAY_TOKEN = previousToken;
      }
    }
  });

  it("lists recorded external failures for a privileged caller", async () => {
    const ledger = createMemoryFailedRequestLedger();
    ledger.record({
      serviceType: "dcs_form",
      payload: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      errorMessage: "playwright hung",
    });
    const { baseUrl } = await startService({ failedRequestLedger: ledger });
    const response = await fetch(`${baseUrl}/ops/failed-requests`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      requests: Array<{ service_type: string; payload: Record<string, unknown> }>;
    };
    expect(body.requests).toEqual([
      expect.objectContaining({
        service_type: "dcs_form",
        payload: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      }),
    ]);
  });
});
