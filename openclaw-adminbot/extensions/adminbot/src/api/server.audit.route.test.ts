// The console shows the latest audit, not a month of it: `/audit?limit=N` is the newest N events,
// still oldest first. Without `limit` the route answers as it always has.
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const auth = { Authorization: `Bearer ${SERVICE_TOKEN}` };
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve) => {
      mock.server.close(() => resolve());
    });
    mock.close();
  }
});

async function start() {
  const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN });
  running.push(mock);
  await new Promise<void>((resolve) => {
    mock.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = mock.server.address() as { port: number };
  for (const n of [1, 2, 3]) {
    mock.store.recordAudit({
      id: `e${n}`,
      type: "test.event",
      timestamp: `2026-10-0${n}T00:00:00.000Z`,
      actor: "service",
    } as Parameters<typeof mock.store.recordAudit>[0]);
  }
  return `http://127.0.0.1:${port}`;
}

async function ids(baseUrl: string, query = "") {
  const response = await fetch(`${baseUrl}/audit${query}`, { headers: auth });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { events: Array<{ id: string }> };
  return body.events.map((event) => event.id).filter((id) => /^e\d$/.test(id));
}

describe("GET /audit", () => {
  it("returns the newest events, oldest first, up to the limit", async () => {
    const baseUrl = await start();
    expect(await ids(baseUrl, "?limit=2")).toEqual(["e2", "e3"]);
    expect(await ids(baseUrl)).toEqual(["e1", "e2", "e3"]);
    expect(await ids(baseUrl, "?limit=junk")).toEqual(["e1", "e2", "e3"]);
  });
});
