// The console shows the latest audit, not a month of it: `/audit?limit=N` is the newest N events,
// still oldest first. Without `limit` the route sends the newest AUDIT_DEFAULT_LIMIT, and
// `?limit=all` is the whole log.
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_DEFAULT_LIMIT } from "./routes/governance.js";
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

  it("caps an unlimited read at the default and sends everything for limit=all", async () => {
    const baseUrl = await start();
    const mock = running.at(-1)!;
    for (let n = 0; n < AUDIT_DEFAULT_LIMIT; n++) {
      mock.store.recordAudit({
        id: `bulk${n}`,
        type: "test.event",
        timestamp: `2026-11-01T00:00:00.${String(n % 1000).padStart(3, "0")}Z`,
        actor: "service",
      } as Parameters<typeof mock.store.recordAudit>[0]);
    }
    const read = async (query: string) => {
      const response = await fetch(`${baseUrl}/audit${query}`, { headers: auth });
      return (await response.json()) as { events: Array<{ id: string }>; total: number };
    };
    const capped = await read("");
    expect(capped.events).toHaveLength(AUDIT_DEFAULT_LIMIT);
    expect(capped.total).toBeGreaterThanOrEqual(AUDIT_DEFAULT_LIMIT + 3);
    // The three older events fall outside the default window; the newest one stays last.
    expect(capped.events.some((event) => event.id === "e1")).toBe(false);
    expect(capped.events.at(-1)?.id).toBe(`bulk${AUDIT_DEFAULT_LIMIT - 1}`);
    const all = await read("?limit=all");
    expect(all.events).toHaveLength(all.total);
    expect(all.events.some((event) => event.id === "e1")).toBe(true);
  });
});
