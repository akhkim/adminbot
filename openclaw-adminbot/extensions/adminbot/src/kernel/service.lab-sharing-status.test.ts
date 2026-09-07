import { expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../contracts/actions.js";
import type { LabDirectorStatus } from "../contracts/lab-sharing-status.js";
import { LabSharingStatusService } from "./service.lab-sharing-status.js";
it("restricts publication, derives actor, hides expired status and clears without logging text", () => {
  let row: LabDirectorStatus | null = null;
  let now = Date.parse("2026-09-07T00:00:00Z");
  const audit = vi.fn();
  const service = new LabSharingStatusService(
    {
      getLabMember: (id) =>
        id === "missing"
          ? undefined
          : ({ id, privilege_level: id === "admin" ? "admin" : "member" } as AdminBotLabMember),
      readDirectorStatus: () => row,
      saveDirectorStatus: (value) => {
        row = value;
      },
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
  expect(row).toBeNull();
});
