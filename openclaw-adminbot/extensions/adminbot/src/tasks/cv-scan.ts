import { createHash } from "node:crypto";
import type { AdminBotRouteContext, CvScanOutcome } from "../api/server.js";
import type { AdminBotCvSnapshot } from "../contracts/actions.js";
import { runAdminBotCvScan, draftFromResults } from "../cv-scan.js";
import type { AdminBotService } from "../kernel/service.js";
import { currentTaskContext, taskStep, withTaskScope } from "./context.js";

/** Keep each member's snapshot, change ledger and checkpoint in the same SQLite commit. */
export async function runPersistentCvScan(
  ctx: AdminBotRouteContext,
  service: AdminBotService,
): Promise<CvScanOutcome> {
  const manifest = await taskStep(
    "cv.manifest",
    {},
    async () => {
      const members = service.listLabMembers();
      if (!members.ok) throw new Error(members.error.message);
      const settings = service.getSettings();
      return {
        members: members.payload.members,
        scannedAt: ctx.cvScanDeps!.now().toISOString(),
        windowMonths: settings.ok ? settings.payload.cv_recency_window_months : undefined,
      };
    },
    { replaySafe: true },
  );
  const results = [];
  for (const member of manifest.members) {
    const item = await withTaskScope(`cv:${member.id}`, () =>
      taskStep(
        `cv.member:${member.id}`,
        member,
        async () => {
          const original = ctx.cvScanDeps!;
          let extraction: Awaited<ReturnType<typeof original.extractText>> | undefined;
          const outcome = await runAdminBotCvScan(
            [member],
            {
              ...original,
              fetchPdf: async (url) => {
                // Retain parsed source input, not transient PDF buffers, across resumed members.
                extraction = await taskStep(
                  `cv.source:${member.id}`,
                  { url },
                  async () => {
                    const pdf = await original.fetchPdf(url, currentTaskContext()?.signal);
                    return original.extractText(pdf, currentTaskContext()?.signal);
                  },
                  { replaySafe: true },
                );
                return new Uint8Array();
              },
              extractText: async () => extraction!,
              now: () => new Date(manifest.scannedAt),
            },
            manifest.windowMonths,
          );
          return {
            result: outcome.result.results[0] ?? null,
            snapshot: outcome.snapshots.get(member.id) ?? null,
          };
        },
        { replaySafe: true },
      ),
    );
    if (!item.result) continue;
    const commit = () => {
      const result = { ...item.result! };
      if (item.snapshot) {
        const current = ctx.store.getLabMember(member.id);
        if (!current || snapshotHash(current.cv_snapshot) !== snapshotHash(member.cv_snapshot)) {
          return {
            ...result,
            status: "failed" as const,
            reason: "CV baseline changed during this scan; start a new scan.",
          };
        }
        const saved = service.upsertLabMember({ ...current, cv_snapshot: item.snapshot });
        if (!saved.ok) return { ...result, status: "failed" as const, reason: saved.error.message };
      }
      if (result.status === "changed" || result.status === "first_scan") {
        ctx.store.recordCvChanges(
          result.added.map((change) => ({
            member_id: result.member_id,
            member_name: result.member_name,
            detected_at: manifest.scannedAt,
            recency: change.recency,
            entry: change.entry,
          })),
        );
      }
      return result;
    };
    const task = currentTaskContext();
    results.push(task ? task.commit(`cv.commit:${member.id}`, item, commit) : commit());
  }
  return {
    ok: true,
    result: {
      scanned_at: manifest.scannedAt,
      results,
      newsletter_draft: draftFromResults(results),
    },
  };
}

function snapshotHash(snapshot: AdminBotCvSnapshot | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshot ?? null))
    .digest("hex");
}
