import { expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../contracts/actions.js";
import type { LabDirectorStatus } from "../contracts/lab-sharing-status.js";
import { LabSharingStatusService } from "./service.lab-sharing-status.js";

/** The service returns a result union; every assertion below is about the success arm. */
function unwrapRead(result: ReturnType<LabSharingStatusService["read"]>) {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

/**
 * A stand-in for the archive table: append-only, newest first, retracting the newest live entry
 * rather than deleting it. Mirrors persistence/lab-sharing-status.ts, which is what the service is
 * actually written against.
 */
function fakeStore(clock: () => number) {
  const rows: LabDirectorStatus[] = [];
  return {
    rows,
    saveDirectorStatus: (value: LabDirectorStatus | null) => {
      if (value) {
        rows.unshift(value);
        return;
      }
      const latest = rows[0];
      if (latest && !latest.retracted_at) {
        rows[0] = { ...latest, retracted_at: new Date(clock()).toISOString() };
      }
    },
    readDirectorStatus: () => rows[0] ?? null,
    listDirectorStatusHistory: (limit = 50) => rows.slice(0, limit),
  };
}

it("restricts publication, derives actor, hides expired status and clears without logging text", () => {
  let now = Date.parse("2026-09-07T00:00:00Z");
  const audit = vi.fn();
  const store = fakeStore(() => now);
  const service = new LabSharingStatusService(
    {
      getLabMember: (id) =>
        id === "missing"
          ? undefined
          : ({ id, privilege_level: id === "admin" ? "admin" : "member" } as AdminBotLabMember),
      ...store,
      recordAudit: audit,
    },
    () => now,
  );
  const input = {
    availability: "busy",
    message: "Synthetic private draft",
    expires_at: "2026-09-07T01:00:00Z",
    updated_by: "spoof",
  };
  expect(service.save("member", input).status).toBe(403);
  expect(service.save("missing", input).status).toBe(403);
  expect(service.read("missing").status).toBe(403);
  expect(service.save("admin", input).status).toBe(200);
  expect(service.read("member")).toMatchObject({
    payload: { status: { updated_by: "admin" }, can_manage: false },
  });
  expect(JSON.stringify(audit.mock.calls)).not.toContain(input.message);
  now = Date.parse(input.expires_at);
  expect(service.read("member")).toMatchObject({ payload: { status: null } });
  expect(service.save("member", null, true).status).toBe(403);
  expect(service.save("admin", null, true).status).toBe(200);
  // Retracted, not deleted: the banner goes dark and the archive still says it was said.
  expect(unwrapRead(service.read("admin")).status).toBeNull();
  expect(store.rows).toHaveLength(1);
  expect(store.rows[0]?.retracted_at).toBeTruthy();
});

// The whole reason the single-row table had to go: the lab could not look up what it had been told
// last week, because publishing this week overwrote it.
it("keeps every broadcast, newest first, and serves the archive to plain members", () => {
  let now = Date.parse("2026-09-01T00:00:00Z");
  const store = fakeStore(() => now);
  const service = new LabSharingStatusService(
    {
      getLabMember: (id) =>
        ({ id, privilege_level: id === "admin" ? "admin" : "member" }) as AdminBotLabMember,
      ...store,
      recordAudit: vi.fn(),
    },
    () => now,
  );

  service.save("admin", {
    availability: "away",
    message: "First broadcast",
    expires_at: "2026-09-05T00:00:00Z",
  });
  now = Date.parse("2026-09-08T00:00:00Z");
  service.save("admin", {
    availability: "away",
    message: "Second broadcast",
    expires_at: "2026-09-12T00:00:00Z",
  });

  const seen = service.read("member");
  if (!seen.ok) throw new Error(seen.error.message);
  expect(seen.payload.status?.message).toBe("Second broadcast");
  expect(seen.payload.history.map((row) => row.message)).toEqual([
    "Second broadcast",
    "First broadcast",
  ]);
  // A member can read the archive; only an admin can add to it.
  expect(seen.payload.can_manage).toBe(false);
  // Each entry is addressable, which is what the audit row now points at.
  expect(new Set(seen.payload.history.map((row) => row.id)).size).toBe(2);
});

// Superseded beats longer-lived: the lab reads the most recent thing it was told.
it("never shows an older broadcast just because it outlasts the newest", () => {
  let now = Date.parse("2026-09-01T00:00:00Z");
  const store = fakeStore(() => now);
  const service = new LabSharingStatusService(
    {
      getLabMember: (id) => ({ id, privilege_level: "admin" }) as AdminBotLabMember,
      ...store,
      recordAudit: vi.fn(),
    },
    () => now,
  );
  service.save("admin", {
    availability: "away",
    message: "Long-running",
    expires_at: "2026-12-31T00:00:00Z",
  });
  now = Date.parse("2026-09-02T00:00:00Z");
  service.save("admin", {
    availability: "busy",
    message: "Short and current",
    expires_at: "2026-09-03T00:00:00Z",
  });

  expect(unwrapRead(service.read("admin")).status?.message).toBe("Short and current");
  // Once the newest expires nothing is shown, even though the older one still has months to run.
  now = Date.parse("2026-09-04T00:00:00Z");
  expect(unwrapRead(service.read("admin")).status).toBeNull();
});
