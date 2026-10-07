import { afterEach, expect, it, vi } from "vitest";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import { taskActivities } from "../task-request.ts";
import type { AdminBotCvDigestJobState } from "./admin.ts";
import { runAdminBotCvScan } from "./task-jobs.ts";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
it("reports partial CV failures only after the deferred scan completes", async () => {
  saveStoredMemberSession({ sessionToken: "synthetic-session", expiresAt: "2099-01-01" });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ task: { id: "scan-1", status: "shed", actions: ["wait"] } }), {
        status: 202,
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ task: { id: "scan-1", status: "completed", actions: ["result"] } }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            results: [
              { member_name: "Synthetic member", status: "changed" },
              { member_name: "Other synthetic member", status: "failed", reason: "CV unavailable" },
            ],
          },
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const host = {
    settings: { adminBotBaseUrl: "http://localhost:8765" } as unknown as UiSettings,
    adminBotCvScanJob: { status: "idle" } as AdminBotCvDigestJobState,
  };
  const pending = runAdminBotCvScan(host);
  await vi.waitFor(() => expect(taskActivities.values().next().value?.task?.status).toBe("shed"));
  expect(host.adminBotCvScanJob.status).toBe("running");
  taskActivities.values().next().value!.act("wait");
  await pending;
  expect(host.adminBotCvScanJob.status).toBe("error");
  expect(host.adminBotCvScanJob.detail).toContain("2 CVs checked; 1 changed; 1 failed");
  expect(host.adminBotCvScanJob.detail).toContain("CV unavailable");
  expect(fetcher.mock.calls.some(([url]) => url.includes("publish"))).toBe(false);
});
