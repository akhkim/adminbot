import { expect, it } from "vitest";
import { currentDirectorStatus, validateDirectorStatus } from "./lab-sharing-status.js";
const now = Date.parse("2026-09-07T00:00:00Z");
const input = {
  availability: "busy",
  message: " Reviewing papers ",
  expires_at: "2026-09-07T06:30:00+05:30",
};
it("normalizes expiry and drops caller-supplied editor metadata", () => {
  expect(
    validateDirectorStatus({ ...input, updated_by: "spoof", updated_at: "fake" }, now),
  ).toEqual({
    availability: "busy",
    message: "Reviewing papers",
    expires_at: "2026-09-07T01:00:00.000Z",
  });
});
it("rejects missing, invalid, timezone-free and already expired publication", () => {
  for (const patch of [
    { availability: "online" },
    { message: " " },
    { message: "x".repeat(501) },
    { expires_at: "invalid" },
    { expires_at: "2026-09-07T01:00:00" },
    { expires_at: "2026-09-07T00:00:00Z" },
  ]) {
    expect(typeof validateDirectorStatus({ ...input, ...patch }, now)).toBe("string");
  }
});
it("stops exposing the status exactly at expiry and fails closed for invalid time", () => {
  const status = {
    ...input,
    id: "bcast_synthetic",
    availability: "busy" as const,
    updated_by: "synthetic",
    updated_at: new Date(now).toISOString(),
  };
  const expiry = Date.parse(status.expires_at);
  expect(currentDirectorStatus(status, expiry - 1)).toBe(status);
  expect(currentDirectorStatus(status, expiry)).toBeNull();
  expect(currentDirectorStatus(status, NaN)).toBeNull();
  expect(currentDirectorStatus(null, now)).toBeNull();
});
