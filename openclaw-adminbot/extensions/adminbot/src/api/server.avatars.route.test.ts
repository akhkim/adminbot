// Uploaded photos leave the service as /avatars/<hash> rather than inline base64 (./avatars.ts):
// the roster stays small, the photo is fetched once and cached for good, and a client that sends
// the path back does not overwrite the photo with a link to itself.
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
// A 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PHOTO = `data:image/png;base64,${PNG_BASE64}`;

const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    mock.close();
  }
});

async function start() {
  const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN });
  running.push(mock);
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const { port } = mock.server.address() as { port: number };
  const saved = mock.service.upsertLabMember({
    id: "ada",
    name: "Ada Lovelace",
    email: "ada@example.org",
    privilege_level: "member",
    avatar_url: PHOTO,
  } as AdminBotLabMemberInput);
  if (!saved.ok) {
    throw new Error(saved.error.message);
  }
  return { mock, id: "ada", baseUrl: `http://127.0.0.1:${port}` };
}

const auth = { Authorization: `Bearer ${SERVICE_TOKEN}` };

describe("profile photos", () => {
  it("sends the roster a path and serves the photo behind it, cacheably and without a session", async () => {
    const { baseUrl } = await start();
    const roster = (await (await fetch(`${baseUrl}/lab/members`, { headers: auth })).json()) as {
      members: Array<{ avatar_url?: string }>;
    };
    const path = roster.members[0]?.avatar_url ?? "";
    expect(path).toMatch(/^\/avatars\/[0-9a-f]{64}$/);

    const photo = await fetch(`${baseUrl}${path}`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.headers.get("cache-control")).toContain("immutable");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await photo.arrayBuffer())).toEqual(Buffer.from(PNG_BASE64, "base64"));

    expect((await fetch(`${baseUrl}/avatars/${"0".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/avatars/nope`)).status).toBe(404);
  });

  it("keeps the stored photo when a client saves the path it was sent", async () => {
    const { mock, id, baseUrl } = await start();
    const roster = (await (await fetch(`${baseUrl}/lab/members`, { headers: auth })).json()) as {
      members: Array<{ avatar_url?: string }>;
    };
    const response = await fetch(`${baseUrl}/lab/members/${id}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_url: `${baseUrl}${roster.members[0]?.avatar_url}` }),
    });
    expect(response.status).toBeLessThan(300);
    expect(mock.store.getLabMember(id)?.avatar_url).toBe(PHOTO);
  });
});
