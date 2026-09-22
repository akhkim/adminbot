import { afterEach, expect, it, vi } from "vitest";
import { isLocalServiceOnlyMode } from "./local-service-mode.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("requires an explicit development flag and loopback URLs for both UI and service", () => {
  const settings = { adminBotUrl: "http://127.0.0.1:8765" };
  vi.stubGlobal("location", new URL("http://127.0.0.1:5173"));
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_ADMINBOT_SERVICE_ONLY", "");
  expect(isLocalServiceOnlyMode(settings)).toBe(false);
  vi.stubEnv("VITE_ADMINBOT_SERVICE_ONLY", "1");
  expect(isLocalServiceOnlyMode(settings)).toBe(true);
  expect(isLocalServiceOnlyMode({ adminBotUrl: "" })).toBe(true);
  expect(isLocalServiceOnlyMode({ adminBotUrl: "https://service.example.test" })).toBe(false);
  expect(isLocalServiceOnlyMode({ adminBotUrl: "http://127.0.0.1.attacker.test" })).toBe(false);
  expect(isLocalServiceOnlyMode({ adminBotUrl: "invalid" })).toBe(false);
  vi.stubGlobal("location", new URL("https://jinesis-admin.vercel.app"));
  expect(isLocalServiceOnlyMode(settings)).toBe(false);
});

it("cannot enable service-only mode in a production build even on localhost", () => {
  vi.stubGlobal("location", new URL("http://localhost:5173"));
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_ADMINBOT_SERVICE_ONLY", "1");
  expect(isLocalServiceOnlyMode({ adminBotUrl: "http://localhost:8765" })).toBe(false);
});
