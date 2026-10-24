import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminBotMockService } from "./server.js";

const running: ReturnType<typeof createAdminBotMockService>[] = [];
afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );
    mock.close();
  }
});
async function start(options: Parameters<typeof createAdminBotMockService>[0] = {}) {
  const mock = createAdminBotMockService({ serviceToken: "synthetic-token", ...options });
  running.push(mock);
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const address = mock.server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return { mock, url: `http://127.0.0.1:${address.port}/calendar/local-lunch-invites/run` };
}

describe("automatic lunch route", () => {
  it("refuses anonymous callers before reading or writing", async () => {
    const read = vi.fn(async () => []);
    const { url } = await start({ calendarEventsReader: read });
    const response = await fetch(url, { method: "POST" });
    expect([401, 403]).toContain(response.status);
    expect(read).not.toHaveBeenCalled();
  });
  it("ignores caller-supplied calendar, events and recipients", async () => {
    const read = vi.fn(async () => []);
    const { mock, url } = await start({ calendarEventsReader: read });
    mock.service.upsertLabMember({
      id: "local",
      name: "Local",
      email: "local@example.test",
      location: "Zurich",
    });
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        calendar_id: "evil",
        attendees: ["evil@example.test"],
        events: [{ summary: "Zurich lunch" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: "jinesis.lab@gmail.com" }),
    );
    expect((await response.json()).invited).toEqual([]);
  });
  it("reports reader failure rather than a successful empty pass", async () => {
    const { mock, url } = await start({
      calendarEventsReader: async () => {
        throw new Error("Calendar unavailable");
      },
    });
    mock.service.upsertLabMember({
      id: "local",
      name: "Local",
      email: "local@example.test",
      location: "Zurich",
    });
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-token" },
    });
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 500,
      body: { error: { message: "Calendar unavailable" } },
    });
  });
});
