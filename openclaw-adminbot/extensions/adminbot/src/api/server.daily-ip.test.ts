// The daily IP reading happens on member requests only: a service token never reaches it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceClock } from "./routes/origin.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "synthetic-service-token";
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve) => {
      mock.server.close(() => resolve());
    });
    mock.close();
  }
});

describe("daily IP reading on authenticated requests", () => {
  it("never looks up the address behind a service token", async () => {
    const geolocateIp = vi.fn(async () => ({ country: "CA", city: "Toronto" }));
    const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN, geolocateIp });
    running.push(mock);
    await new Promise<void>((resolve) => {
      mock.server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = mock.server.address() as { port: number };
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/audit?limit=1`, {
        headers: {
          Authorization: `Bearer ${SERVICE_TOKEN}`,
          "X-AdminBot-Device-TZ": "Europe/Zurich",
        },
      });
      expect(response.status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(geolocateIp).not.toHaveBeenCalled();
  });
});

describe("deviceClock", () => {
  const req = (headers: Record<string, string>) =>
    ({ headers }) as unknown as Parameters<typeof deviceClock>[0];

  it("reads the zone name and offset headers", () => {
    expect(
      deviceClock(
        req({ "x-adminbot-device-tz": "Europe/Zurich", "x-adminbot-device-tz-offset": "120" }),
      ),
    ).toEqual({ tz: "Europe/Zurich", offsetMinutes: 120 });
  });

  it("drops a malformed or impossible offset, and returns nothing when both are absent", () => {
    expect(deviceClock(req({ "x-adminbot-device-tz-offset": "lots" }))).toBeUndefined();
    expect(deviceClock(req({ "x-adminbot-device-tz-offset": "9999" }))).toBeUndefined();
    expect(deviceClock(req({}))).toBeUndefined();
  });

  it("drops the offset with an unusable zone, which privacy browsers send whatever the clock", () => {
    // Firefox resistFingerprinting, Tor and Brave report UTC and 0. Neither is a clock.
    for (const tz of ["UTC", "Etc/UTC", "GMT", "Etc/GMT+5"]) {
      expect(
        deviceClock(req({ "x-adminbot-device-tz": tz, "x-adminbot-device-tz-offset": "0" })),
      ).toBeUndefined();
    }
    // An offset sent with no zone name at all is still read.
    expect(deviceClock(req({ "x-adminbot-device-tz-offset": "-240" }))).toEqual({
      offsetMinutes: -240,
    });
  });
});

describe("GET /member-map/coverage", () => {
  it("answers an admin caller and refuses an anonymous one", async () => {
    const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN });
    running.push(mock);
    await new Promise<void>((resolve) => {
      mock.server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = mock.server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/member-map/coverage`;
    const anonymous = await fetch(url);
    expect([401, 403]).toContain(anonymous.status);
    const admin = await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as { counts: Record<string, number>; stale: unknown[] };
    expect(body.counts).toMatchObject({ ip: 0, unplaced: expect.any(Number), suspected_vpn: 0 });
    expect(Array.isArray(body.stale)).toBe(true);
  });
});
