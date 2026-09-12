import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { resolveInferenceGateConfig } from "../inference/config.js";
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
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
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
    config: resolveInferenceGateConfig(
      {},
      { capacity, queue: { sweepIntervalMs: 0 }, health: { intervalMs: 0 } },
    ),
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
    seedMember(mock, { id: "ada", name: "Ada", email: "ada@cs.toronto.edu", privilege_level: "member" });
    seedMember(mock, { id: "bob", name: "Bob", email: "bob@cs.toronto.edu", privilege_level: "member" });
    await approveClaim(mock, baseUrl, "ada", "ada@cs.toronto.edu");
    await approveClaim(mock, baseUrl, "bob", "bob@cs.toronto.edu");
    const ada = await loginToken(baseUrl, "ada@cs.toronto.edu");
    const bob = await loginToken(baseUrl, "bob@cs.toronto.edu");

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
      inference: { request_id: string; state: string; message: string; can_wait: boolean };
    };
    expect(shedBody.inference.state).toBe("shed");
    expect(shedBody.inference.message).toMatch(/GPU busy, 0 ahead of you/u);
    expect(shedBody.inference.can_wait).toBe(true);
    const id = shedBody.inference.request_id;

    // The same request again, response lost: same row, no new one.
    const retry = await fetch(`${baseUrl}/privacy/tasks`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${ada}`, "Idempotency-Key": "ada-1" }),
      body: JSON.stringify({ task: "Draft a note", privacy: "private" }),
    });
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { inference: { request_id: string } }).inference.request_id).toBe(id);
    expect(gate.stats().rows.shed).toBe(1);

    // Bob cannot see, read, or convert Ada's request; a handle is not authority.
    for (const route of [`/inference/requests/${id}`, `/inference/requests/${id}/result`]) {
      const res = await fetch(`${baseUrl}${route}`, {
        headers: { Authorization: `Bearer ${bob}` },
      });
      expect(res.status).toBe(404);
    }
    const bobWait = await fetch(`${baseUrl}/inference/requests/${id}/wait`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bob}` },
    });
    expect(bobWait.status).toBe(404);
    expect(gate.stats().queued).toBe(0);
    // And anonymously, nothing at all.
    expect((await fetch(`${baseUrl}/inference/requests/${id}`)).status).toBe(401);

    // Ada converts it to waiting without re-sending the task.
    const wait = await fetch(`${baseUrl}/inference/requests/${id}/wait`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect(wait.status).toBe(202);
    expect(((await wait.json()) as { state: string }).state).toBe("queued");
    expect(gate.stats().queued).toBe(1);
    // A second click reports the current state and enqueues nothing more.
    const again = await fetch(`${baseUrl}/inference/requests/${id}/wait`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect(again.status).toBe(202);
    expect(gate.stats().queued).toBe(1);

    // The model frees up. Bob's task is two calls (classify, then a local run), each its own permit;
    // Ada's classify runs from the stored body in between, in line order. Release until both settle.
    let bobsResponse: Response | undefined;
    void bobsTask.then((response) => {
      bobsResponse = response;
    });
    await until(() => {
      model.releaseAll();
      return bobsResponse !== undefined && gate.status("ada", id)?.state === "completed";
    });
    expect(bobsResponse?.status).toBe(200);

    const status = await fetch(`${baseUrl}/inference/requests/${id}`, {
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect(((await status.json()) as { state: string }).state).toBe("completed");
    const result = await fetch(`${baseUrl}/inference/requests/${id}/result`, {
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect(result.status).toBe(200);
    const mine = await fetch(`${baseUrl}/inference/requests`, {
      headers: { Authorization: `Bearer ${ada}` },
    });
    expect(((await mine.json()) as { requests: unknown[] }).requests).toHaveLength(1);

    // The audit table saw one admitted and one completed for Ada's row and nothing twice. Read from
    // the gate's own database: this test's gate is in-memory and separate from the service store,
    // which is exactly the seam production closes by handing the gate the store's handle.
    const events = (
      gate.database
        .prepare("SELECT event_json FROM adminbot_audit_events ORDER BY rowid")
        .all() as Array<{ event_json: string }>
    )
      .map((row) => JSON.parse(row.event_json) as { type: string; details?: { request_id?: string } })
      .filter((e) => e.details?.request_id === id);
    expect(events.map((e) => e.type)).toEqual([
      "inference.shed",
      "inference.waited",
      "inference.admitted",
      "inference.completed",
    ]);
  });

  it("stores and reads back the always-wait preference per member, and honors it on the next task", async () => {
    const { baseUrl, mock, gate, model } = await startService(1);
    seedMember(mock, { id: "ada", name: "Ada", email: "ada@cs.toronto.edu", privilege_level: "member" });
    seedMember(mock, { id: "bob", name: "Bob", email: "bob@cs.toronto.edu", privilege_level: "member" });
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
    expect(gate.stats().rows.shed).toBe(0);
    let adasResponse: Response | undefined;
    void adas.then((response) => {
      adasResponse = response;
    });
    await until(() => {
      model.releaseAll();
      return adasResponse !== undefined;
    });
    expect(adasResponse?.status).toBe(200);
  });

  it("keeps /inference/status privileged", async () => {
    const { baseUrl, mock } = await startService(1);
    seedMember(mock, { id: "pat", name: "Pat", email: "pat@cs.toronto.edu", privilege_level: "member" });
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
