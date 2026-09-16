import type { UiSettings } from "../../storage.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import { taskFetch } from "../task-request.ts";
import type { AdminBotCvDigestJobState, AdminBotHost } from "./admin.ts";
import { loadWorkshopNudgePreview } from "./admin.ts";

export async function runAdminBotCvScan(host: {
  settings: UiSettings;
  adminBotCvScanJob: AdminBotCvDigestJobState;
}) {
  const session = loadStoredMemberSession();
  if (!session || host.adminBotCvScanJob.status === "running") return;
  host.adminBotCvScanJob = { status: "running" };
  try {
    const response = await taskFetch(`${resolveAdminBotBaseUrl(host.settings)}/cv/scan`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error?.message ?? "CV scan failed.");
    const rows = (result?.result?.results ?? result?.results) as
      | Array<{ status: string; member_name?: string; reason?: string }>
      | undefined;
    const failures = rows?.filter((row) => row.status === "failed") ?? [];
    const changed =
      rows?.filter((row) => row.status === "changed" || row.status === "first_scan").length ?? 0;
    host.adminBotCvScanJob = {
      status: failures.length ? "error" : "ok",
      detail: `${rows?.length ?? 0} CVs checked; ${changed} changed; ${failures.length} failed. ${failures.map((row) => `${row.member_name ?? "Member"}: ${row.reason ?? "scan failed"}`).join(" ")} Publish the digest separately.`,
      finishedAtMs: Date.now(),
    };
  } catch (error) {
    host.adminBotCvScanJob = {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      finishedAtMs: Date.now(),
    };
  }
}

export async function retryWorkshopTask(host: AdminBotHost) {
  const session = loadStoredMemberSession();
  const id = host.adminBotWorkshopNudges.run?.task_id;
  if (!session || !id) return;
  const action = host.adminBotWorkshopNudges.run?.task_status === "shed" ? "wait" : "retry";
  try {
    const response = await taskFetch(
      `${resolveAdminBotBaseUrl(host.settings)}/tasks/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      },
    );
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body?.error?.message ?? "The match could not resume.");
    }
    await loadWorkshopNudgePreview(host);
  } catch (error) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
