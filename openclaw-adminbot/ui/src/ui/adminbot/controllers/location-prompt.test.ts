import { expect, it } from "vitest";
import { prepareProfileLocationPrompt } from "./location-prompt.ts";

it("defers blocked reads and retries an earlier rejected read after unlocking", () => {
  const host: Parameters<typeof prepareProfileLocationPrompt>[0] = { adminBotLocationDrift: null };
  expect(prepareProfileLocationPrompt(host, true)).toBe(false);
  expect(host.adminBotLocationDrift).toBeUndefined();
  expect(prepareProfileLocationPrompt(host, true)).toBe(false);
  expect(prepareProfileLocationPrompt(host, false)).toBe(true);
  host.adminBotLocationDrift = null;
  expect(prepareProfileLocationPrompt(host, false)).toBe(false);
});
