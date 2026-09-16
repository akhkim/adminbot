import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { inferenceTestConfig } from "../inference/config.test-support.js";
import { createInferenceGate, type InferenceFetch } from "../inference/gate.js";
import { openInferenceTestDb } from "../inference/gate.test-support.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

type RunningService = {
  baseUrl: string;
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanupPaths: string[];
};

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    entry.mock.inferenceGate.setShutdownGraceMs(0, "test");
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    await entry.mock.close();
    for (const cleanupPath of entry.cleanupPaths) {
      await rm(cleanupPath, { force: true });
    }
  }
});

/** A model whose calls resolve only when the test says so, to keep the gate's slots occupied. */
function heldModel() {
  const pending: Array<() => void> = [];
  let calls = 0;
  const fetchImpl: InferenceFetch = async () => {
    calls += 1;
    await new Promise<void>((resolve) => pending.push(resolve));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  classification: "private",
                  sanitized_task: "x",
                  replacements: [],
                }),
              },
            },
          ],
        }),
    };
  };
  return {
    fetchImpl,
    get calls() {
      return calls;
    },
    releaseAll() {
      while (pending.length) {
        pending.shift()?.();
      }
    },
  };
}

async function startService(capacity = 1) {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-inference-sensitive-info-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const model = heldModel();
  const gate = createInferenceGate({
    db: openInferenceTestDb(),
    env: {},
    fetchImpl: model.fetchImpl,
    config: inferenceTestConfig({ capacity }),
  });
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    inferenceGate: gate,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push({ baseUrl, mock, cleanupPaths: [sensitiveInfoPath] });
  return { baseUrl, mock, gate, model };
}

/** Polls rather than sleeps: the first request through a fresh server takes an unpredictable time. */
async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function seedMember(
  mock: ReturnType<typeof createAdminBotMockService>,
  input: AdminBotLabMemberInput,
): void {
  const result = mock.service.upsertLabMember(input);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

async function approveClaim(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
  memberId: string,
  email: string,
): Promise<void> {
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ member_id: memberId, email, password: "correcthorse" }),
  });
  const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  const registration = (
    (await pending.json()) as { registrations: Array<{ id: string; member_id?: string }> }
  ).registrations.find((entry) => entry.member_id === memberId);
  if (!registration) {
    throw new Error(`no pending registration for ${memberId}`);
  }
  const approved = mock.auth.approveRegistration(registration.id, "seed-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
}

async function loginToken(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  return ((await res.json()) as { session_token: string }).session_token;
}

describe("AdminBot inference routes", () => {
  it("sheds a busy privacy task with a handle, lets only its owner wait on it, and dedupes a retry", async () => {
    const { baseUrl, mock, gate, model } = await startService(1);
    seedMember(mock, {
      id: "ada",
      name: "Ada",
      email: "ada@cs.toronto.edu",
      privilege_level: "member",
    });
    seedMember(mock, {
      id: "bob",
      name: "Bob",
      email: "bob@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(mock, baseUrl, "ada", "ada@cs.toronto.edu");
    await approveClaim(mock, baseUrl, "bob", "bob@cs.toronto.edu");
    const ada = await loginToken(baseUrl, "ada@cs.toronto.edu");
    const bob = await loginToken(baseUrl, "bob@cs.toronto.edu");
    mock.taskRuntime.pause();
    const shared = mock.taskRuntime.submit({
      kind: "workshop.match",
      owner: "system:workshop-match",
      input: {},
    });
    expect(
      (
        await fetch(`${baseUrl}/tasks/${shared.id}`, {
          headers: { Authorization: `Bearer ${bob}` },
        })
      ).status,
    ).toBe(404);
    mock.taskRuntime.cancel(shared.id);
    mock.taskRuntime.resume();

    // Bob takes the only slot and the model holds his call.
    const bobsTask = fetch(`${baseUrl}/privacy/tasks`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bob}` }),
      body: JSON.stringify({ task: "Summarize my private notes", privacy: "private" }),
    });
    await until(() => gate.stats().in_flight === 1);

    // Ada arrives: shed, with a handle and a sentence the UI can show.
    const shed = await fetch(`${baseUrl}/privacy/tasks`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${ada}`, "Idempotency-Key": "ada-1" }),
      body: JSON.stringify({ task: "Draft a note", privacy: "private" }),
    });
    expect(shed.status).toBe(409);
    const shedBody = (await shed.json()) as {
      task: { id: string; status: string; actions: string[] };
    };
    expect(shedBody.task.status).toBe("shed");
    expect(shedBody.task.actions).toContain("wait");
    const id = shedBody.task.id;
    const retry = await fetch(`${baseUrl}/privacy/tasks`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${ada}`, "Idempotency-Key": "ada-1" }),
      body: JSON.stringify({ task: "Draft a note", privacy: "private" }),
    });
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { task: { id: string } }).task.id).toBe(id);
    expect(mock.taskRuntime.metrics().shed).toBe(1);
    for (const route of [`/tasks/${id}`, `/tasks/${id}/result`]) {
      expect(
        (await fetch(`${baseUrl}${route}`, { headers: { Authorization: `Bearer ${bob}` } })).status,
      ).toBe(404);
    }
    expect(
      (
        await fetch(`${baseUrl}/tasks/${id}/wait`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bob}` },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${baseUrl}/tasks/${id}`)).status).toBe(401);
    const wait = await fetch(`${baseUrl}/tasks/${id}/wait`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect(wait.status).toBe(202);
    expect(((await wait.json()) as { task: { status: string } }).task.status).toBe("running");
    await until(() => gate.stats().queued === 1);
    expect(gate.stats().queued).toBe(1);
    const again = await fetch(`${baseUrl}/tasks/${id}/wait`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect(again.status).toBe(202);
    expect(gate.stats().queued).toBe(1);
    await until(() => {
      model.releaseAll();
      return (
        mock.taskRuntime.get(id)?.status === "completed" && mock.taskRuntime.metrics().active === 0
      );
    });
    expect([200, 202]).toContain((await bobsTask).status);
    const result = await fetch(`${baseUrl}/tasks/${id}/result`, {
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ route: "local", output: expect.any(String) });
    // Both application tasks completed their reasoning stage, not just classification.
    expect(model.calls).toBe(4);
    const mine = await fetch(`${baseUrl}/tasks`, { headers: { Authorization: `Bearer ${ada}` } });
    expect(((await mine.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("stores and reads back the always-wait preference per member, and honors it on the next task", async () => {
    const { baseUrl, mock, gate, model } = await startService(1);
    seedMember(mock, {
      id: "ada",
      name: "Ada",
      email: "ada@cs.toronto.edu",
      privilege_level: "member",
    });
    seedMember(mock, {
      id: "bob",
      name: "Bob",
      email: "bob@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(mock, baseUrl, "ada", "ada@cs.toronto.edu");
    await approveClaim(mock, baseUrl, "bob", "bob@cs.toronto.edu");
    const ada = await loginToken(baseUrl, "ada@cs.toronto.edu");
    const bob = await loginToken(baseUrl, "bob@cs.toronto.edu");

    const put = await fetch(`${baseUrl}/inference/preferences`, {
      method: "PUT",
      headers: jsonHeaders({ Authorization: `Bearer ${ada}` }),
      body: JSON.stringify({ inference_always_wait: true }),
    });
    expect(put.status).toBe(200);
    const bobs = await fetch(`${baseUrl}/inference/preferences`, {
      headers: { Authorization: `Bearer ${bob}` },
    });
    expect(await bobs.json()).toEqual({});

    void fetch(`${baseUrl}/privacy/tasks`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bob}` }),
      body: JSON.stringify({ task: "hold the slot", privacy: "private" }),
    });
    await until(() => gate.stats().in_flight === 1);
    const adas = fetch(`${baseUrl}/privacy/tasks`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${ada}` }),
      body: JSON.stringify({ task: "queue me", privacy: "private" }),
    });
    await until(() => gate.stats().queued === 1);
    // Not shed: Ada's preference put her in line without a header.
    expect(mock.taskRuntime.metrics().shed).toBe(0);
    let adasResponse: Response | undefined;
    void adas.then((response) => {
      adasResponse = response;
    });
    await until(() => {
      model.releaseAll();
      return (
        adasResponse !== undefined &&
        mock.taskRuntime.metrics().active === 0 &&
        mock.taskRuntime.metrics().queued === 0
      );
    });
    expect([200, 202]).toContain(adasResponse?.status);
  });

  it("lets a browser preflight the wait header from an allowed origin", async () => {
    const { baseUrl } = await startService(1);
    const preflight = await fetch(`${baseUrl}/privacy/tasks`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,idempotency-key,x-inference-wait",
      },
    });
    expect(preflight.status).toBe(204);
    const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("x-inference-wait");
    expect(allowed).toContain("idempotency-key");
  });

  it("keeps /inference/status privileged", async () => {
    const { baseUrl, mock } = await startService(1);
    seedMember(mock, {
      id: "pat",
      name: "Pat",
      email: "pat@cs.toronto.edu",
      privilege_level: "member",
    });
    await approveClaim(mock, baseUrl, "pat", "pat@cs.toronto.edu");
    const pat = await loginToken(baseUrl, "pat@cs.toronto.edu");
    expect(
      (await fetch(`${baseUrl}/inference/status`, { headers: { Authorization: `Bearer ${pat}` } }))
        .status,
    ).toBe(403);
    const asService = await fetch(`${baseUrl}/inference/status`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(asService.status).toBe(200);
    expect(((await asService.json()) as { capacity: number }).capacity).toBe(1);
  });
});

describe("inference operator controls", () => {
  it("requires privileges and validates live settings and explicit cancellation IDs", async () => {
    const { baseUrl, mock, gate, model } = await startService();
    seedMember(mock, {
      id: "pat",
      name: "Pat",
      email: "pat@example.invalid",
      privilege_level: "member",
    });
    await approveClaim(mock, baseUrl, "pat", "pat@example.invalid");
    const pat = await loginToken(baseUrl, "pat@example.invalid");
    const adminHeaders = jsonHeaders({ Authorization: `Bearer ${SERVICE_TOKEN}` });
    for (const route of ["pause", "resume", "cancel-pending", "settings"]) {
      const method = route === "settings" ? "PUT" : "POST";
      expect(
        (
          await fetch(`${baseUrl}/inference/${route}`, {
            method,
            headers: jsonHeaders({ Authorization: `Bearer ${pat}` }),
            body: "{}",
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await fetch(`${baseUrl}/inference/pause`, { method: "POST", headers: adminHeaders })).status,
    ).toBe(200);
    const outcome = await gate.run({
      owner: "service",
      caller: "test",
      request: {
        route: "chat/completions",
        baseUrl: "http://127.0.0.1:8000/v1",
        purpose: "test",
        body: { model: "m" },
      },
    });
    expect(outcome.kind).toBe("shed");
    expect(model.calls).toBe(0);
    expect(
      (
        await fetch(`${baseUrl}/inference/settings`, {
          method: "PUT",
          headers: adminHeaders,
          body: JSON.stringify({ shutdown_grace_ms: -1 }),
        })
      ).status,
    ).toBe(400);
    const updated = await fetch(`${baseUrl}/inference/settings`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ shutdown_grace_ms: 25 }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).shutdown_grace_ms).toBe(25);
    expect(
      (
        await fetch(`${baseUrl}/inference/cancel-pending`, {
          method: "POST",
          headers: adminHeaders,
          body: "{}",
        })
      ).status,
    ).toBe(400);
    if (outcome.kind !== "shed") {
      throw new Error("expected shed");
    }
    const cancelled = await fetch(`${baseUrl}/inference/cancel-pending`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ request_ids: [outcome.id] }),
    });
    expect((await cancelled.json()).cancelled).toEqual([outcome.id]);
    const resumed = await fetch(`${baseUrl}/inference/resume`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect((await resumed.json()).paused).toBe(false);
  });
});
