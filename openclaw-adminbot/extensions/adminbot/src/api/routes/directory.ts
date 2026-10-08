// The lab directory around the roster: member map, CV digest, and Slack channel names.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.

import { randomUUID } from "node:crypto";
import type { AdminBotCvScanResult } from "../../contracts/actions.js";
import {
  type AdminBotCvScanDeps,
  buildNewsletterDraft,
  draftMemberBlurb,
  runAdminBotCvScan,
} from "../../cv-scan.js";
import {
  AdminBotService,
  type AdminBotServiceResponse,
  type AdminBotSlackChannelNamingEvent,
} from "../../kernel/service.js";
import { renderCvDigestDocument } from "../../workflows/cv/digest-doc.js";
import {
  toPrivilegedMemberMap,
  toPublicMemberMapSummary,
} from "../../workflows/members/member-map.js";
import { asString, readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import type { AdminBotRouteContext } from "./context.js";
import { isPrivileged, principalActor, privilegedOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";

// The oldest timestamp any ledger row can carry, so "list everything" reuses the same
// `detected_at >= ?` query the since-filter uses rather than needing a second statement.
export const LEDGER_EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * How long the workspace's channel names are reused before Slack is asked again.
 *
 * Channels are created a handful of times a month and the caller is a form somebody is typing
 * into, so the walk -- which is paginated and can be several round-trips on a large workspace --
 * must not run per keystroke. Five minutes is long enough that filling in a form costs one call
 * and short enough that a channel made a moment ago shows up while the person is still at the
 * desk they made it from.
 */
export const SLACK_CHANNEL_CACHE_MS = 5 * 60 * 1000;

export let slackChannelCache: { at: number; names: string[] } | undefined;

export const directoryRoutes: readonly Route[] = [
  get("/member-map", ({ res, url, principal, ctx }) => {
    const { service } = ctx;
    // Public in shape (see GET /member-map in ANONYMOUS_ROUTES), but only ever public in a
    // counts-only shape: publishing 100+ people's names and locations is a decision to make
    // deliberately, not a side effect of building the view, so only an admin gets the version
    // with who is where. Everyone else -- anonymous or a signed-in non-admin member alike --
    // gets a headcount per city.
    const result = service.memberMap();
    if (!result.ok) {
      sendServiceResult(res, result);
      return;
    }
    sendJson(
      res,
      200,
      isPrivileged(principal)
        ? {
            mode: "full",
            ...toPrivilegedMemberMap(result.payload, {
              listUnplaced: url.searchParams.get("unplaced") === "list",
            }),
          }
        : { mode: "summary", ...toPublicMemberMapSummary(result.payload) },
    );
  }),
  post(
    "/member-map/refresh",
    privilegedOnly(async ({ res, ctx, principal }) => {
      const { service } = ctx;
      if (!ctx.fetchSlackLocations) {
        sendJson(res, 503, { error: { message: "slack location lookup is not configured" } });
        return;
      }
      sendServiceResult(
        res,
        await service.refreshMemberMap(ctx.fetchSlackLocations, principalActor(principal)),
      );
    }),
  ),
  post(
    "/cv/scan",
    privilegedOnly(async ({ res, ctx }) => {
      const { service } = ctx;
      if (!ctx.cvScanDeps) {
        sendJson(res, 503, { error: { message: "cv scanning is not configured" } });
        return;
      }
      const scan = await scanAndRecordCvs(ctx, service);
      if (!scan.ok) {
        sendServiceResult(res, scan.failure);
        return;
      }
      sendJson(res, 200, scan.result);
    }),
  ),
  post(
    "/cv/publish-digest",
    privilegedOnly(async ({ res, ctx, principal }) => {
      const { service } = ctx;
      if (!ctx.cvScanDeps) {
        sendJson(res, 503, { error: { message: "cv scanning is not configured" } });
        return;
      }
      if (!ctx.cvDigestPublisher) {
        sendJson(res, 503, {
          error: {
            message:
              "cv digest publishing is not configured — set ADMINBOT_CV_DIGEST_DOC_ID and restart",
          },
        });
        return;
      }
      const publisher = ctx.cvDigestPublisher;
      const scan = await scanAndRecordCvs(ctx, service);
      if (!scan.ok) {
        sendServiceResult(res, scan.failure);
        return;
      }
      // Rendered from the whole ledger, not from the scan that just ran: a scan consumes its own
      // diff, so a quiet week returns nothing and would otherwise blank the document. See
      // workflows/cv/digest-doc.ts.
      const document = renderCvDigestDocument(
        ctx.store.listCvChangesSince(LEDGER_EPOCH),
        new Date(),
      );
      try {
        await publisher.publish(document.markdown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.store.recordAudit({
          id: `aud_${randomUUID()}`,
          timestamp: new Date().toISOString(),
          type: "cv.digest_failed",
          actor: principalActor(principal),
          details: { document_url: publisher.documentUrl, reason: message },
        });
        sendJson(res, 502, { error: { message: `could not write the CV digest doc: ${message}` } });
        return;
      }
      ctx.store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        type: "cv.digest_published",
        actor: principalActor(principal),
        details: {
          document_url: publisher.documentUrl,
          day_count: document.day_count,
          change_count: document.change_count,
          scanned_at: scan.result.scanned_at,
        },
      });
      sendJson(res, 200, {
        document_url: publisher.documentUrl,
        published_at: scan.result.scanned_at,
        day_count: document.day_count,
        change_count: document.change_count,
        scan: scan.result,
      });
    }),
  ),
  get(
    "/cv/digest",
    privilegedOnly(({ res, url, ctx }) => {
      const since = url.searchParams.get("since")?.trim();
      if (!since || Number.isNaN(Date.parse(since))) {
        sendJson(res, 400, { error: { message: "since must be an ISO timestamp" } });
        return;
      }
      const changes = ctx.store.listCvChangesSince(since);
      sendJson(res, 200, {
        since,
        changes,
        newsletter_draft: buildNewsletterDraft(
          changes.map((change) => ({
            memberName: change.member_name,
            change: { entry: change.entry, recency: change.recency },
          })),
        ),
      });
    }),
  ),
  post(
    /^\/cv\/blurb\/([^/]+)$/u,
    privilegedOnly(async ({ res, ctx, params }) => {
      const member = ctx.store.getLabMember(decodeURIComponent(params[1]));
      if (!member) {
        sendJson(res, 404, { error: { message: "member not found" } });
        return;
      }
      const entries = member.cv_snapshot?.entries ?? [];
      if (!entries.length) {
        // Distinct from a model failure: there is nothing wrong, this member's CV has simply never
        // been scanned, and the fix is to scan rather than to retry.
        sendJson(res, 409, {
          error: { message: `${member.name} has no scanned CV yet — run a CV scan first` },
        });
        return;
      }
      try {
        const text = await draftMemberBlurb(
          {
            name: member.name,
            ...(member.role ? { role: member.role } : {}),
            ...(member.research_topics?.length ? { research_topics: member.research_topics } : {}),
          },
          entries,
        );
        sendJson(res, 200, { member_id: member.id, params: text });
      } catch (error) {
        sendJson(res, 502, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    }),
  ),
  post(
    "/members/directory/refresh-slack",
    privilegedOnly(async ({ res, ctx, principal }) => {
      const { service } = ctx;
      if (
        !ctx.resolveSlackUserIdsByEmail &&
        !ctx.fetchSlackTimezones &&
        !ctx.fetchSlackMessageCounts
      ) {
        sendJson(res, 503, { error: { message: "slack directory sync is not configured" } });
        return;
      }
      sendServiceResult(
        res,
        await service.refreshMemberDirectoryFromSlack(
          {
            ...(ctx.resolveSlackUserIdsByEmail
              ? { resolveSlackUserIdsByEmail: ctx.resolveSlackUserIdsByEmail }
              : {}),
            ...(ctx.fetchSlackTimezones ? { fetchSlackTimezones: ctx.fetchSlackTimezones } : {}),
            ...(ctx.fetchSlackMessageCounts
              ? { fetchSlackMessageCounts: ctx.fetchSlackMessageCounts }
              : {}),
          },
          principalActor(principal),
        ),
      );
    }),
  ),
  post(
    "/slack/channel-naming/events",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      const event: AdminBotSlackChannelNamingEvent = {
        event_type: asString(body.event_type) as AdminBotSlackChannelNamingEvent["event_type"],
        channel_id: asString(body.channel_id),
        channel_name: asString(body.channel_name),
        ...(asString(body.owner_user_id) ? { owner_user_id: asString(body.owner_user_id) } : {}),
        ...(asString(body.purpose) ? { purpose: asString(body.purpose) } : {}),
        ...(asString(body.topic) ? { topic: asString(body.topic) } : {}),
      };
      sendServiceResult(
        res,
        await service.processSlackChannelNamingEvent(event, principalActor(principal)),
      );
    }),
  ),
  post(
    "/slack/channel-naming/sweep/run",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      const now = asString(body.now);
      sendServiceResult(
        res,
        await service.runSlackChannelNamingSweep(
          principalActor(principal),
          now || new Date().toISOString(),
        ),
      );
    }),
  ),
  get("/slack/channels", async ({ res, ctx, principal }) => {
    // Names only -- no ids, no membership, no topics. The one caller is the project form asking
    // "is there already a channel called this", and a route that returned the workspace's shape
    // would be a directory export behind a question about one string.
    //
    // Any signed-in member may ask. Filing a project is a member action, so refusing the check to
    // the person doing it would leave exactly them unable to get the alias right.
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (!ctx.fetchSlackChannelNames) {
      // 503 and not an empty list. An empty list reads as "no channel matches", which would tell
      // somebody their correct alias is wrong -- the failure this check exists to prevent.
      sendJson(res, 503, {
        error: { message: "slack channel lookup is not configured on this deployment" },
      });
      return;
    }
    try {
      const channels = await readSlackChannelNames(ctx.fetchSlackChannelNames);
      sendJson(res, 200, { channels });
    } catch (error) {
      sendJson(res, 502, {
        error: { message: error instanceof Error ? error.message : "slack channel lookup failed" },
      });
    }
  }),
];

/**
 * The cached channel-name read.
 *
 * A failure is deliberately not cached: the next press should retry rather than repeat an error
 * for five minutes, because the usual cause is a token or a scope somebody is in the middle of
 * fixing.
 */
export async function readSlackChannelNames(
  fetchNames: () => Promise<string[]>,
): Promise<string[]> {
  const now = Date.now();
  if (slackChannelCache && now - slackChannelCache.at < SLACK_CHANNEL_CACHE_MS) {
    return slackChannelCache.names;
  }
  const names = await fetchNames();
  slackChannelCache = { at: now, names };
  return names;
}

export type CvScanFailure = Extract<AdminBotServiceResponse<never>, { ok: false }>;

export type CvScanOutcome =
  | { ok: true; result: AdminBotCvScanResult }
  | { ok: false; failure: CvScanFailure };

/**
 * Runs a CV scan over the roster, persists each member's new snapshot, and appends what changed to
 * the ledger.
 *
 * Shared by `/cv/scan` and `/cv/publish-digest` because the digest job is "scan, then publish":
 * two copies would let the button and the scan disagree about what a scan even does, and the
 * ordering below (snapshots before ledger) is load-bearing enough that it should exist once.
 */
export async function scanAndRecordCvs(
  ctx: AdminBotRouteContext,
  service: AdminBotService,
): Promise<CvScanOutcome> {
  const members = service.listLabMembers();
  if (!members.ok) {
    return { ok: false, failure: members };
  }
  // Read at scan time rather than captured at boot, so changing the window takes effect on the
  // next scan instead of the next restart.
  const cvSettings = service.getSettings();
  const { result, snapshots } = await runAdminBotCvScan(
    members.payload.members,
    // Callers check this before calling; asserted here so the helper has one contract.
    ctx.cvScanDeps as AdminBotCvScanDeps,
    cvSettings.ok ? cvSettings.payload.cv_recency_window_months : undefined,
  );
  // Snapshots are written through upsertLabMember rather than straight to the store so the scan
  // cannot bypass member validation, and so a bad extraction fails one member's save instead of
  // corrupting the roster.
  for (const member of members.payload.members) {
    const snapshot = snapshots.get(member.id);
    if (!snapshot) {
      continue;
    }
    const saved = service.upsertLabMember({ ...member, cv_snapshot: snapshot });
    if (!saved.ok) {
      const failed = result.results.find((entry) => entry.member_id === member.id);
      if (failed) {
        failed.status = "failed";
        failed.reason = `could not save cv snapshot: ${saved.error.message}`;
      }
    }
  }
  // Recorded after the snapshots are saved, so a member whose snapshot failed to store does not
  // leave a change on the ledger the next scan would then never re-detect.
  ctx.store.recordCvChanges(
    result.results
      .filter((entry) => entry.status === "changed" || entry.status === "first_scan")
      .flatMap((entry) =>
        entry.added.map((change) => ({
          member_id: entry.member_id,
          member_name: entry.member_name,
          detected_at: result.scanned_at,
          recency: change.recency,
          entry: change.entry,
        })),
      ),
  );
  return { ok: true, result };
}
