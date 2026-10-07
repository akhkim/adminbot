// Reference and integrity checks over manuscripts, and the OpenReview reviewing cycle.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.

import fs from "node:fs";
import path from "node:path";
import { readGogSheetRows } from "../../connectors/gog.js";
import { createOpenReviewSubmissionReader } from "../../connectors/openreview-submissions.js";
import { createPangramScorer } from "../../connectors/pangram.js";
import {
  requiredDatabasesPausedUntil,
  createPdfReferenceChecker,
  extractPdfFullText,
} from "../../connectors/reference-check.js";
import { type AdminBotServiceStore, AdminBotService } from "../../kernel/service.js";
import { IclrIntegrityWatch } from "../../workflows/papers/iclr-integrity-watch.js";
import { OpenReviewCitationWatch } from "../../workflows/papers/openreview-citation-watch.js";
import { readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import type { AdminBotMockServiceOptions } from "./context.js";
import { adminSessionOnly, principalActor, privilegedOnly } from "./guards.js";
import { get, post, route, type Route, startingWith } from "./router.js";

export const reviewsRoutes: readonly Route[] = [
  post(
    "/tools/notification-drafts",
    adminSessionOnly(async ({ req, res, ctx }) => {
      await ctx.notificationDrafts(req, res);
    }),
  ),
  post(
    "/reference-check/pdf",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      await ctx.checkUploadedPdf(req, res, principalActor(principal));
    }),
  ),
  get(
    "/openreview/citation-checks",
    privilegedOnly(({ res, ctx }) => {
      const watch = ctx.openReviewCitationWatch;
      sendJson(res, 200, {
        enabled: Boolean(watch),
        ...(watch ? watch.status() : { running: false }),
        checks: ctx.store.listOpenReviewCitationChecks(),
      });
    }),
  ),
  post(
    "/openreview/citation-checks/run",
    privilegedOnly(async ({ res, ctx }) => {
      const watch = ctx.openReviewCitationWatch;
      if (!watch) {
        sendJson(res, 503, {
          error: {
            message:
              "OpenReview citation checks are off — set ADMINBOT_OPENREVIEW_CITATION_CHECKS=1, OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD",
          },
        });
        return;
      }
      try {
        sendJson(res, 202, await watch.start());
      } catch (error) {
        sendJson(res, 502, {
          error: {
            message:
              error instanceof Error ? error.message : "could not list OpenReview submissions",
          },
        });
      }
    }),
  ),
  get(
    "/openreview/integrity-checks",
    privilegedOnly(({ res, ctx }) => {
      const watch = ctx.iclrIntegrityWatch;
      sendJson(res, 200, {
        enabled: Boolean(watch),
        ...(watch ? watch.status() : { running: false }),
        checks: ctx.store.listPaperAiTextChecks(),
      });
    }),
  ),
  post(
    "/openreview/integrity-checks/run",
    privilegedOnly(async ({ res, ctx }) => {
      const watch = ctx.iclrIntegrityWatch;
      if (!watch) {
        sendJson(res, 503, {
          error: {
            message:
              "ICLR integrity checks are off — set ADMINBOT_ICLR_INTEGRITY_CHECKS=1, PANGRAM_API_KEY, OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD",
          },
        });
        return;
      }
      try {
        sendJson(res, 202, await watch.start());
      } catch (error) {
        sendJson(res, 502, {
          error: {
            message:
              error instanceof Error ? error.message : "could not list OpenReview submissions",
          },
        });
      }
    }),
  ),
  route(
    ["GET", "POST"],
    "/reference-scans",
    privilegedOnly(async ({ req, res, url, ctx }) => {
      if (req.method === "GET") {
        const scan = ctx.referenceScans.get(
          url.searchParams.get("submission_id") ?? "",
          url.searchParams.get("pdf_sha256") ?? "",
        );
        sendJson(res, scan ? 200 : 404, scan ?? { error: { message: "scan not found" } });
        return;
      }
      const body = readRecord(await readJson(req));
      if (typeof body.submission_id !== "string" || typeof body.notify_email !== "string") {
        sendJson(res, 400, { error: { message: "submission_id and notify_email are required" } });
        return;
      }
      try {
        const result = await ctx.referenceScans.propose(body.submission_id, body.notify_email);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 422, {
          error: { message: error instanceof Error ? error.message : "scan proposal failed" },
        });
      }
    }),
  ),
  route(
    "*",
    startingWith("/openreview/"),
    privilegedOnly(async ({ req, res, url, ctx }) => {
      const { service } = ctx;
      if (!ctx.openReviewWorkflow) {
        sendJson(res, 503, { error: { message: "openreview workflow is not configured" } });
        return;
      }
      const workflow = ctx.openReviewWorkflow;
      if (req.method === "GET" && url.pathname === "/openreview/status") {
        sendServiceResult(res, service.listOpenReviewStatus());
        return;
      }
      if (req.method === "POST" && url.pathname === "/openreview/cycle/run") {
        // Dry run unless the caller explicitly asks to send, so a stray trigger of the
        // route reports what it would have done instead of mailing anyone.
        const body = (await readJson(req)) as { send?: boolean } | undefined;
        sendJson(res, 200, await workflow.runCycle({ dryRun: body?.send !== true }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/openreview/load-forms") {
        sendJson(res, 200, { forms: await workflow.loadForms() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/openreview/suggest-reviewers") {
        const venueId = url.searchParams.get("venue");
        if (!venueId) {
          sendJson(res, 400, { error: { message: "venue query parameter is required" } });
          return;
        }
        sendJson(res, 200, { submissions: await workflow.suggestReviewers(venueId) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/openreview/assignments") {
        const body = (await readJson(req)) as {
          venue_id?: string;
          submission?: string;
          reviewer?: string;
          remove?: boolean;
        };
        if (!body?.venue_id || !body?.submission || !body?.reviewer) {
          sendJson(res, 400, {
            error: { message: "venue_id, submission and reviewer are required" },
          });
          return;
        }
        const result = await workflow.applyAssignment({
          venueId: body.venue_id,
          submission: body.submission,
          reviewer: body.reviewer,
          ...(body.remove ? { remove: true } : {}),
        });
        sendJson(res, result.ok === true ? 200 : 502, result);
        return;
      }
      // A path under /openreview/ that none of the above answered.
      sendJson(res, 404, { error: { message: "not found" } });
    }),
  ),
];

// Escalation-sensitive governance (global settings, sensitive-info read/write, registration
// approve/reject) must be driven by a real member session. The shared service principal is used by
// every agent tool call regardless of which member is chatting, so treating it as admin here would
// let any signed-in member perform these actions through the agent. Require an admin member
// Bearer session and deny the service principal outright.
/**
 * The sweep is opt-in at deployment: it sends the extracted bibliographies of restricted
 * submissions to public scholarly databases, which the operator has to have agreed to.
 */
export function createOpenReviewCitationWatch(
  options: AdminBotMockServiceOptions,
  store: AdminBotServiceStore,
  service: AdminBotService,
): OpenReviewCitationWatch | undefined {
  const reader =
    options.openReviewSubmissionReader ??
    (process.env.ADMINBOT_OPENREVIEW_CITATION_CHECKS?.trim() === "1"
      ? createOpenReviewSubmissionReader()
      : undefined);
  if (!reader) {
    return undefined;
  }
  const notifyEmail =
    options.citationWatchNotifyEmail ??
    (process.env.ADMINBOT_CITATION_CHECK_NOTIFY?.trim() ||
      process.env.ADMINBOT_CONTACT_EMAILS?.split(",")[0]?.trim() ||
      undefined);
  // One back-off state for the process: every check the sweep runs honors the same 429s.
  const cooldowns = new Map<string, number>();
  return new OpenReviewCitationWatch({
    store,
    service,
    reader,
    pausedUntil: () => requiredDatabasesPausedUntil(cooldowns),
    pauseBetweenMs: options.citationWatchChecker ? 0 : 60_000,
    maxPauseWaitMs: options.citationWatchChecker ? 0 : 90_000,
    check:
      options.citationWatchChecker ??
      createPdfReferenceChecker({
        maxReferences: 300,
        requireAllDatabases: true,
        allowOversized: true,
        cooldowns,
        // Unattended: a minute's wait for Crossref or DBLP beats a paper left half-checked.
        maxCooldownWaitMs: 90_000,
        ...(process.env.OPENALEX_API_KEY?.trim()
          ? { openAlexApiKey: process.env.OPENALEX_API_KEY.trim() }
          : {}),
      }),
    ...(notifyEmail ? { notifyEmail } : {}),
  });
}

/**
 * Opt-in on its own flag, separate from the citation checks: it sends the main text of restricted
 * ICLR submissions to Pangram, a third-party AI-text detector, which the operator has to have
 * agreed to on top of the citation lookups.
 */
export function createIclrIntegrityWatch(
  options: AdminBotMockServiceOptions,
  store: AdminBotServiceStore,
  service: AdminBotService,
): IclrIntegrityWatch | undefined {
  const enabled = process.env.ADMINBOT_ICLR_INTEGRITY_CHECKS?.trim() === "1";
  const apiKey = process.env.PANGRAM_API_KEY?.trim();
  const score =
    options.aiTextScorer ?? (enabled && apiKey ? createPangramScorer({ apiKey }) : undefined);
  const reader =
    options.openReviewSubmissionReader ?? (score ? createOpenReviewSubmissionReader() : undefined);
  if (!score || !reader) {
    return undefined;
  }
  const threshold = Number(process.env.ADMINBOT_ICLR_AI_THRESHOLD);
  // The ICLR 2027 run ends at 08:00 Toronto time on 26 September 2026. A default rather than only an
  // env line, so a host that never had the line set still stops; the env reopens it for a later cycle.
  const until = new Date(
    process.env.ADMINBOT_ICLR_INTEGRITY_UNTIL?.trim() || DEFAULT_ICLR_INTEGRITY_UNTIL,
  );
  return new IclrIntegrityWatch({
    store,
    service,
    reader,
    score,
    extractText: options.integrityTextExtractor ?? ((pdf) => extractPdfFullText(pdf)),
    ...(threshold > 0 && threshold < 1 ? { threshold } : {}),
    // An unparseable date ends the check now rather than letting it run forever.
    until: Number.isNaN(until.getTime()) ? new Date(0) : until,
    // Operator Slack ids for the hourly digest. Anything that is not a user id is dropped rather
    // than handed to Slack.
    reportTo: (process.env.ADMINBOT_ICLR_INTEGRITY_REPORT_SLACK_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[UW][A-Z0-9]{2,}$/u.test(id)),
    ...integritySheet(),
    ...integrityDigestChannel(options.databasePath),
    // Operator Slack ids for confirmed hallucinated citations, filtered the same way.
    citationReportTo: (process.env.ADMINBOT_ICLR_CITATION_REPORT_SLACK_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[UW][A-Z0-9]{2,}$/u.test(id)),
  });
}

export const DEFAULT_ICLR_INTEGRITY_UNTIL = "2026-09-26T08:00:00-04:00";

/**
 * The channel the hourly digest lives in, as one message edited each sweep. Which message that is
 * is kept in a small file beside the database, so a restart edits it rather than starting another;
 * without a database (tests, a memory store) it is remembered for the life of the process only.
 */
export function integrityDigestChannel(databasePath: string | undefined):
  | {
      reportChannel: {
        channelId: string;
        message: { load: () => string | undefined; save: (ts: string) => void };
      };
    }
  | Record<string, never> {
  const channelId = process.env.ADMINBOT_ICLR_INTEGRITY_REPORT_SLACK_CHANNEL?.trim();
  if (!channelId || !/^[CG][A-Z0-9]{2,}$/u.test(channelId)) {
    return {};
  }
  const file = databasePath
    ? path.join(path.dirname(databasePath), "iclr-integrity-digest.json")
    : undefined;
  let remembered: string | undefined;
  return {
    reportChannel: {
      channelId,
      message: {
        load: () => {
          if (remembered || !file) {
            return remembered;
          }
          try {
            const saved = JSON.parse(fs.readFileSync(file, "utf8")) as {
              channel?: string;
              ts?: string;
            };
            // A digest moved to another channel starts a new message there.
            remembered = saved.channel === channelId ? saved.ts : undefined;
          } catch {
            remembered = undefined;
          }
          return remembered;
        },
        save: (ts) => {
          remembered = ts;
          if (file) {
            try {
              fs.writeFileSync(file, JSON.stringify({ channel: channelId, ts }));
            } catch {
              // Remembered in memory regardless; the worst case after a restart is one new message.
            }
          }
        },
      },
    },
  };
}

/**
 * The lab's paper sheet the integrity sweep writes scores into, when one is configured. The tab
 * defaults to the one the lab keeps its ICLR papers on.
 */
export function integritySheet():
  | { sheet: { spreadsheetId: string; tab: string; read: () => Promise<string[][]> } }
  | Record<string, never> {
  const spreadsheetId = process.env.ADMINBOT_ICLR_INTEGRITY_SHEET_ID?.trim();
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/u.test(spreadsheetId)) {
    return {};
  }
  const tab = process.env.ADMINBOT_ICLR_INTEGRITY_SHEET_TAB?.trim() || "Papers-iclr-feedback";
  return {
    sheet: {
      spreadsheetId,
      tab,
      read: () =>
        readGogSheetRows(spreadsheetId, { range: `'${tab.replace(/'/gu, "''")}'!A1:Z1000` }),
    },
  };
}
