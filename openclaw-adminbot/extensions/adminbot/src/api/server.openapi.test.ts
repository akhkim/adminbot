import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import openapi from "../../cli/openapi.generated.json" with { type: "json" };
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const active: { mock: ReturnType<typeof createAdminBotMockService>; directory: string }[] = [];
afterEach(async () => {
  for (const { mock, directory } of active.splice(0)) {
    mock.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});
async function lab() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "adminbot-openapi-http-"));
  const mock = createAdminBotMockService({
    serviceToken: "synthetic-service-token",
    sensitiveInfoPath: path.join(directory, "sensitive.md"),
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
  });
  active.push({ mock, directory });
  await new Promise<void>((resolve) => {
    mock.server.listen(0, "127.0.0.1", resolve);
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing service address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  const tokens: Record<string, string> = {};
  for (const [id, name, level] of [
    ["author", "Test Author", "member"],
    ["other", "Other Member", "member"],
    ["admin", "Test Admin", "admin"],
  ] as const) {
    expect(
      mock.service.upsertLabMember(withCompleteProfile({ id, name, privilege_level: level })).ok,
    ).toBe(true);
    await mock.auth.claim({
      member_id: id,
      email: `${id}@example.test`,
      password: "synthetic-password",
    });
    const registrations = await mock.auth.listRegistrations();
    const registration = registrations.find((record) => record.member_id === id);
    if (!registration) {
      throw new Error("missing registration");
    }
    expect((await mock.auth.approveRegistration(registration.id, "bootstrap-admin")).ok).toBe(true);
    const login = await mock.auth.login({
      email: `${id}@example.test`,
      password: "synthetic-password",
    });
    if (!login.ok) {
      throw new Error("login failed");
    }
    tokens[id] = login.payload.session_token;
  }
  expect(
    mock.service.upsertPaper({
      id: "p1",
      title: "Synthetic paper",
      authors: ["Test Author"],
      author_links: [{ name: "Test Author", member_id: "author" }],
      current_step: "brainstorming_docs",
      notes: "Keep this note",
    }).ok,
  ).toBe(true);
  return { mock, url, tokens, directory };
}
function cli(url: string, directory: string, args: string[], token?: string, input = "") {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../cli/adminbot.mjs", import.meta.url)), ...args],
      {
        env: {
          ...process.env,
          ADMINBOT_URL: url,
          ADMINBOT_TOKEN: token ?? "",
          ADMINBOT_CREDENTIALS_FILE: path.join(directory, "credentials.json"),
        },
        stdio: "pipe",
      },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

describe("the generated OpenAPI surface", () => {
  // It lists every route, admin-only ones included, and the service is reachable from the
  // internet through the tunnel -- so a signed-in caller only.
  it("serves exactly the packaged contract, and only to an authenticated caller", async () => {
    const { url, tokens } = await lab();
    expect((await fetch(`${url}/openapi.json`)).status).toBe(401);
    const response = await fetch(`${url}/openapi.json`, {
      headers: { Authorization: `Bearer ${tokens.author}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(openapi);
  });

  it("runs CLI login, weekly notes, checklist updates, and stage changes against the actual service", async () => {
    const { mock, url, directory } = await lab();
    const login = await cli(
      url,
      directory,
      ["auth", "login", "--email", "author@example.test", "--password-stdin"],
      undefined,
      "synthetic-password\n",
    );
    expect(login.code, login.err).toBe(0);
    expect(login.out).not.toContain("session_token");
    expect((await stat(path.join(directory, "credentials.json"))).mode & 0o777).toBe(0o600);
    for (const args of [
      ["work", "update", "p1", "--note", "Finished the experiment"],
      [
        "tasks",
        "update",
        "p1",
        "project_folder",
        "--link",
        "https://docs.google.com/document/d/synthetic",
      ],
      ["papers", "progress", "p1", "--step", "overleaf_writing"],
    ]) {
      const result = await cli(url, directory, args);
      expect(result.code, result.err).toBe(0);
    }
    const cycle = mock.service.listPaperSlots("p1");
    expect(cycle.ok).toBe(true);
    if (!cycle.ok) {
      throw new Error("missing paper");
    }
    expect(cycle.payload.paper).toMatchObject({
      title: "Synthetic paper",
      notes: "Keep this note",
      current_step: "overleaf_writing",
    });
    expect(cycle.payload.slots.find((slot) => slot.slot === "project_folder")?.status).toBe(
      "provided",
    );
    expect(cycle.payload.weekly_updates).toEqual([
      expect.objectContaining({ member_id: "author", body: "Finished the experiment" }),
    ]);
    expect((await cli(url, directory, ["auth", "logout"])).code).toBe(0);
    expect((await cli(url, directory, ["auth", "whoami"])).code).toBe(3);
  });

  it("keeps stage edits scoped to authors/admins and preserves unrelated fields", async () => {
    const { mock, url, tokens } = await lab();
    const update = (token: string | undefined, body: unknown) =>
      fetch(`${url}/papers/p1/progress`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await update(undefined, { current_step: "submission" })).status).toBe(401);
    expect((await update("synthetic-service-token", { current_step: "submission" })).status).toBe(
      401,
    );
    expect((await update(tokens.other, { current_step: "submission" })).status).toBe(403);
    expect((await update(tokens.author, { current_step: "invented" })).status).toBe(400);
    expect((await update(tokens.author, {})).status).toBe(400);
    const missing = await fetch(`${url}/papers/no-such-paper/progress`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.author}` },
      body: JSON.stringify({ current_step: "submission" }),
    });
    expect(missing.status).toBe(404);
    expect(
      (
        await update(tokens.admin, {
          current_step: "submission",
          title: "Forged title",
          reminder: { escalation_after_business_days: 0 },
        })
      ).status,
    ).toBe(200);
    const saved = mock.service.listPaperSlots("p1");
    expect(saved.ok && saved.payload.paper).toMatchObject({
      title: "Synthetic paper",
      notes: "Keep this note",
      current_step: "submission",
      authors: ["Test Author"],
    });
  });

  // The handlers validate their own input and say what was wrong; the contract does not stand in
  // front of them with a generic refusal.
  it("keeps the handlers' own validation and still rejects execution without approval", async () => {
    const { url, tokens, directory } = await lab();
    const invalid = await fetch(`${url}/proposals`, {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic-service-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "invented", summary: "invalid" }),
    });
    expect(invalid.status).toBe(400);
    const proposed = await fetch(`${url}/proposals`, {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic-service-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "email.send",
        summary: "Synthetic mail",
        proposed_payload: { to: "recipient@example.test", subject: "Test", body: "Test" },
      }),
    });
    expect(proposed.status).toBe(200);
    const action = (await proposed.json()) as { id: string };
    const result = await cli(
      url,
      directory,
      ["proposals", "execute", action.id, "--live"],
      tokens.admin,
    );
    expect(result.code).toBe(4);
  });
});
