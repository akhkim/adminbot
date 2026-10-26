// The lab directory around the roster: member map, CV digest, and Slack channel names.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.

import { createHash, randomUUID } from "node:crypto";
import type {
  AdminBotCvScanMemberResult,
  AdminBotCvScanResult,
  AdminBotCvSnapshot,
} from "../../contracts/actions.js";
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
  buildTalkLeaderboard,
  type AdminBotTalkLeaderboard,
} from "../../workflows/cv/talk-leaderboard.js";
import {
  memberMapHour,
  toPrivilegedMemberMap,
  toPublicMemberMapSummary,
} from "../../workflows/members/member-map.js";
import { asString, readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import type { AdminBotRouteContext } from "./context.js";
import { isPrivileged, principalActor, privilegedOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";
import { principalRole, sendNotModified, versionEtag } from "./version-etag.js";

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
    //
    // Sign-in cities place people for anyone signed in to the lab -- members see a headcount per
    // city, admins the names -- and each member's own "Show me on the lab map as" setting decides
    // whether theirs is used at all. Never for an anonymous visitor: a public headcount on "Lyon"
    // would tell the internet where a lab member signed in from, so that map uses only what members
    // stated. Either way only a city leaves here, never an IP, its coordinates, or a history.
    //
    // Beyond the roster, the body depends only on that entitlement and the hour memberMapMemo
    // rebuilds on, so those, the roster generation, the mode and the one parameter name it exactly,
    // and a repeat poll is answered unbuilt.
    const privileged = isPrivileged(principal);
    const loginCity = principal.kind !== "anonymous";
    const listUnplaced = privileged && url.searchParams.get("unplaced") === "list";
    const version = ctx.store.labMemberVersion?.();
    const etag =
      version === undefined
        ? undefined
        : versionEtag("member-map", [
            version,
            principalRole(principal),
            privileged,
            listUnplaced,
            loginCity,
            memberMapHour(),
            ctx.service.memberMapPlacesVersion(),
          ]);
    if (etag && sendNotModified(res, etag)) {
      return;
    }
    const result = service.memberMap({ loginCity });
    if (!result.ok) {
      sendServiceResult(res, result);
      return;
    }
    // The provider's licence wants its credit wherever the data shows, and a country pin on the
    // summary can come from a sign-in as much as a city on the full map can.
    const attribution = {
      ...(ctx.ipGeolocationAttribution ? { attribution: ctx.ipGeolocationAttribution } : {}),
      // GeoNames (CC BY 4.0) names the cities device positions reduce to and draws the ones the
      // gazetteer lacks, so its credit sits beside the IP provider's.
      ...(ctx.placeAttribution ? { place_attribution: ctx.placeAttribution } : {}),
    };
    sendJson(
      res,
      200,
      privileged
        ? {
            mode: "full",
            ...toPrivilegedMemberMap(result.payload, { listUnplaced }),
            ...attribution,
            // For the admin status line: is sign-in geolocation on, and through what. Never the
            // database path or a token -- only the provider kind and whether the proxy is trusted.
            ...(ctx.ipGeolocationProvider
              ? {
                  ip_geolocation: {
                    active: ctx.ipGeolocationProvider !== "off",
                    provider: ctx.ipGeolocationProvider,
                    trust_proxy: ctx.trustProxyHeaders,
                  },
                }
              : {}),
          }
        : { mode: "summary", ...toPublicMemberMapSummary(result.payload), ...attribution },
      { etag },
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
      const published = await publishCvDigest(
        ctx,
        publisher,
        principalActor(principal),
        scan.result.scanned_at,
      );
      if (!published.ok) {
        sendJson(res, 502, {
          error: { message: `could not write the CV digest doc: ${published.message}` },
        });
        return;
      }
      sendJson(res, 200, {
        document_url: publisher.documentUrl,
        published_at: scan.result.scanned_at,
        day_count: published.day_count,
        change_count: published.change_count,
        talk_leaderboard: published.talk_leaderboard,
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
  get("/cv/talk-leaderboard", ({ res, url, ctx, principal }) => {
    // Any signed-in member, not just admins: the list used to sit in the lab meeting doc every
    // member reads, and it carries names and counts only -- never a talk title or a CV.
    if (principal.kind === "anonymous") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    // Defaults to this year, the one the guidebook's travel perk is decided on; ?year= reads back
    // a past one from the same CVs.
    const raw = url.searchParams.get("year")?.trim();
    const year = raw ? Number(raw) : new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      sendJson(res, 400, { error: { message: "year must be a four-digit year" } });
      return;
    }
    const board = currentTalkLeaderboard(ctx.service, new Date(), year);
    if (!board) {
      sendJson(res, 500, { error: { message: "could not read the lab roster" } });
      return;
    }
    sendJson(res, 200, { ...board, sweep: cvSweepStatus(ctx, new Date()) });
  }),
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
  get(
    "/member-map/coverage",
    // Admin-only: names, and when each person was last here. Never IP addresses or coordinates.
    privilegedOnly(({ res, ctx }) => {
      sendServiceResult(res, ctx.service.memberMapCoverage());
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
  onProgress?: AdminBotCvScanDeps["onProgress"],
): Promise<CvScanOutcome> {
  const members = service.listLabMembers();
  if (!members.ok) {
    return { ok: false, failure: members };
  }
  // Read at scan time rather than captured at boot, so changing the window takes effect on the
  // next scan instead of the next restart.
  const cvSettings = service.getSettings();
  // Each member is saved, and their changes put on the ledger, as soon as their CV is read rather
  // than once the whole roster is done: a sweep can take most of an hour, and a deploy restarting
  // the host midway would otherwise throw every read away. Snapshot first, then ledger, per member,
  // so a member whose snapshot failed to store does not leave a change on the ledger the next scan
  // would then never re-detect.
  const record = (entry: AdminBotCvScanMemberResult, snapshot: AdminBotCvSnapshot | undefined) => {
    // Re-read, so an edit made to the member while the sweep ran is not overwritten.
    const member = ctx.store.getLabMember(entry.member_id);
    if (snapshot) {
      // Written through upsertLabMember rather than straight to the store so the scan cannot bypass
      // member validation, and so a bad extraction fails one member's save instead of corrupting
      // the roster.
      const saved = member
        ? service.upsertLabMember({ ...member, cv_snapshot: snapshot })
        : { ok: false as const, error: { message: "member was removed during the scan" } };
      if (!saved.ok) {
        entry.status = "failed";
        entry.reason = `could not save cv snapshot: ${saved.error.message}`;
        entry.added = [];
        return;
      }
    }
    if (entry.status !== "changed" && entry.status !== "first_scan") {
      return;
    }
    try {
      ctx.store.recordCvChanges(
        entry.added.map((change) => ({
          member_id: entry.member_id,
          member_name: entry.member_name,
          detected_at: scannedAt,
          recency: change.recency,
          entry: change.entry,
        })),
      );
    } catch (error) {
      // The new snapshot carries the PDF's hash, so keeping it would make the next sweep skip this
      // CV as unchanged and its changes would never reach the ledger. Put the old one back, named
      // explicitly because upsertLabMember patches: a first scan's missing key would keep the new one.
      if (snapshot && member) {
        service.upsertLabMember({ ...member, cv_snapshot: member.cv_snapshot });
      }
      throw error;
    }
  };
  const scanDeps = ctx.cvScanDeps as AdminBotCvScanDeps;
  const scannedAt = scanDeps.now().toISOString();
  const { result } = await runAdminBotCvScan(
    members.payload.members,
    // Callers check this before calling; asserted here so the helper has one contract.
    { ...scanDeps, now: () => new Date(scannedAt), onProgress, onMemberScanned: record },
    cvSettings.ok ? cvSettings.payload.cv_recency_window_months : undefined,
  );
  return { ok: true, result };
}

type CvDigestPublishOutcome =
  | {
      ok: true;
      day_count: number;
      change_count: number;
      talk_leaderboard: AdminBotTalkLeaderboard | null;
    }
  | { ok: false; message: string };

/**
 * Rewrites the CV Updates doc from the whole ledger and audits the attempt either way.
 *
 * Rendered from the whole ledger, not from the scan that just ran: a scan consumes its own diff,
 * so a quiet week returns nothing and would otherwise blank the document. See
 * workflows/cv/digest-doc.ts.
 */
async function publishCvDigest(
  ctx: AdminBotRouteContext,
  publisher: NonNullable<AdminBotRouteContext["cvDigestPublisher"]>,
  actor: string,
  scannedAt: string,
): Promise<CvDigestPublishOutcome> {
  const { document, talkLeaderboard, body_hash } = renderCvDigest(ctx);
  try {
    await publisher.publish(document.markdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: "cv.digest_failed",
      actor,
      details: { document_url: publisher.documentUrl, reason: message },
    });
    return { ok: false, message };
  }
  ctx.store.recordAudit({
    id: `aud_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    type: "cv.digest_published",
    actor,
    details: {
      document_url: publisher.documentUrl,
      day_count: document.day_count,
      change_count: document.change_count,
      scanned_at: scannedAt,
      body_hash,
    },
  });
  return {
    ok: true,
    day_count: document.day_count,
    change_count: document.change_count,
    talk_leaderboard: talkLeaderboard,
  };
}

/**
 * The CV Updates doc as it would be published now, with a hash of everything but its "Updated"
 * date so two renders of the same content compare equal on different days.
 */
function renderCvDigest(ctx: AdminBotRouteContext) {
  const now = new Date();
  const talkLeaderboard = currentTalkLeaderboard(ctx.service, now);
  const document = renderCvDigestDocument(
    ctx.store.listCvChangesSince(LEDGER_EPOCH),
    now,
    talkLeaderboard ?? undefined,
  );
  const body_hash = createHash("sha256")
    .update(document.markdown.replace(/^_Updated .*_$/mu, ""))
    .digest("hex");
  return { document, talkLeaderboard, body_hash };
}

/** The body hash of the last doc that was actually written, from the audit log. */
function lastPublishedDigestHash(ctx: AdminBotRouteContext): string | undefined {
  let latest: { timestamp: string; hash?: unknown } | undefined;
  for (const event of ctx.store.listAuditEvents()) {
    if (event.type === "cv.digest_published" && (!latest || event.timestamp > latest.timestamp)) {
      latest = { timestamp: event.timestamp, hash: event.details?.body_hash };
    }
  }
  return typeof latest?.hash === "string" ? latest.hash : undefined;
}

/**
 * This calendar year's talk leaderboard from the roster as it stands, or null when the roster
 * cannot be read -- the doc is then published without the section rather than with an empty one
 * that would read as "nobody gave a talk".
 */
function currentTalkLeaderboard(
  service: AdminBotService,
  now: Date,
  year: number = now.getUTCFullYear(),
): AdminBotTalkLeaderboard | null {
  const members = service.listLabMembers();
  return members.ok ? buildTalkLeaderboard(members.payload.members, year) : null;
}

export const CV_SWEEP_ACTOR = "system:cv-sweep";
const CV_SWEEP_EVENT = "cv.sweep_completed";
const CV_SWEEP_FAILED_EVENT = "cv.sweep_failed";
const CV_SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * How a sweep went, member by member, without naming anyone: counts per outcome and per failure
 * reason. Enough to tell "35 Drive links are private" from "the model is down" in the audit log.
 */
export function summarizeCvScan(results: AdminBotCvScanResult["results"]) {
  const statuses: Record<string, number> = {};
  const failures: Record<string, number> = {};
  for (const entry of results) {
    statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
    if ((entry.status === "failed" || entry.status === "skipped") && entry.reason) {
      const reason = entry.reason.slice(0, 160);
      failures[reason] = (failures[reason] ?? 0) + 1;
    }
  }
  return { statuses, failures };
}

export type CvDailySweepOutcome =
  | { status: "skipped"; reason: "not_configured" | "not_due" | "running" }
  | { status: "failed"; reason: string }
  | { status: "done"; changed_members: number; published: boolean };

let cvSweepRunning = false;

/**
 * Where the daily CV read stands, for the leaderboard to say "reading 40 of 230, about 25 minutes
 * left" instead of looking finished while half the CVs are unread.
 */
export type CvSweepStatus =
  | {
      state: "reading";
      started_at: string;
      done: number;
      total: number;
      // From the pace so far; null until the first CV is through and there is a pace to go on.
      eta_seconds: number | null;
    }
  | {
      state: "idle";
      last_completed_at: string | null;
      last_failed_at: string | null;
      // When the next read is due. A past or null time means it starts at the next hourly check.
      next_due_at: string | null;
    };

type CvSweepState = {
  progress?: { started_at: number; done: number; total: number };
  // Read once from the audit log, then kept current here, so the leaderboard does not scan the
  // whole audit log on every page load.
  lastCompletedAt?: string | null;
  lastFailedAt?: string | null;
};

// Keyed by store so test servers, each with their own store, do not see one another's sweeps.
const cvSweepStates = new WeakMap<object, CvSweepState>();

function cvSweepState(ctx: AdminBotRouteContext): CvSweepState {
  let state = cvSweepStates.get(ctx.store);
  if (!state) {
    state = {};
    cvSweepStates.set(ctx.store, state);
  }
  if (state.lastCompletedAt === undefined || state.lastFailedAt === undefined) {
    const latest = (type: string) =>
      ctx.store
        .listAuditEvents()
        .filter((event) => event.type === type)
        .reduce<string | null>(
          (last, event) => (!last || event.timestamp > last ? event.timestamp : last),
          null,
        );
    state.lastCompletedAt = latest(CV_SWEEP_EVENT);
    state.lastFailedAt = latest(CV_SWEEP_FAILED_EVENT);
  }
  return state;
}

export function cvSweepStatus(ctx: AdminBotRouteContext, now: Date): CvSweepStatus {
  const state = cvSweepState(ctx);
  const progress = state.progress;
  if (progress) {
    const elapsed = now.getTime() - progress.started_at;
    return {
      state: "reading",
      started_at: new Date(progress.started_at).toISOString(),
      done: progress.done,
      total: progress.total,
      eta_seconds:
        progress.done > 0
          ? Math.round(((elapsed / progress.done) * (progress.total - progress.done)) / 1000)
          : null,
    };
  }
  const last = state.lastCompletedAt ?? null;
  return {
    state: "idle",
    last_completed_at: last,
    last_failed_at: state.lastFailedAt ?? null,
    next_due_at: last ? new Date(Date.parse(last) + CV_SWEEP_PERIOD_MS).toISOString() : null,
  };
}

/**
 * The once-a-day CV pass: re-scan every linked CV and, when anything new landed on the ledger,
 * refresh the CV Updates doc. Nothing is messaged; the doc and the ledger are the only output.
 *
 * Called hourly by the host and runs only once 24 hours have passed since the last completed
 * sweep, read from the audit log. A plain 24-hour timer would restart its countdown on every
 * deploy, and the host is redeployed more often than daily, so it would never fire.
 *
 * Unchanged CVs cost a download and a hash, not a model call: runAdminBotCvScan skips extraction
 * when the text hash matches the stored snapshot. Extraction stays on the loopback model.
 */
export async function runCvDailySweep(
  ctx: AdminBotRouteContext,
  service: AdminBotService,
  now: Date = new Date(),
): Promise<CvDailySweepOutcome> {
  if (!ctx.cvScanDeps) {
    return { status: "skipped", reason: "not_configured" };
  }
  if (cvSweepRunning) {
    return { status: "skipped", reason: "running" };
  }
  const state = cvSweepState(ctx);
  const last = state.lastCompletedAt;
  if (last && now.getTime() - Date.parse(last) < CV_SWEEP_PERIOD_MS) {
    return { status: "skipped", reason: "not_due" };
  }
  cvSweepRunning = true;
  const startedAt = Date.now();
  // The host fires this from a timer that discards the promise, so a sweep that fails has to say
  // so here or nobody learns why CVs stopped being read. A failure is its own event type: it must
  // not count as the day's sweep, or a broken model would only be retried tomorrow.
  const recordFailure = (reason: string): CvDailySweepOutcome => {
    ctx.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: now.toISOString(),
      type: CV_SWEEP_FAILED_EVENT,
      actor: CV_SWEEP_ACTOR,
      details: { reason },
    });
    state.lastFailedAt = now.toISOString();
    return { status: "failed", reason };
  };
  try {
    let scan: CvScanOutcome;
    try {
      scan = await scanAndRecordCvs(ctx, service, (done, total) => {
        state.progress = { started_at: startedAt, done, total };
      });
    } catch (error) {
      return recordFailure(error instanceof Error ? error.message : String(error));
    }
    if (!scan.ok) {
      return recordFailure(scan.failure.error.message);
    }
    const changed = scan.result.results.filter(
      (entry) =>
        (entry.status === "changed" || entry.status === "first_scan") && entry.added.length > 0,
    ).length;
    // Rewritten only when the document would read differently from the last one published: an
    // unchanged doc would just gain a fresh "Updated" date. Compared on the rendered body rather
    // than on this run's diff, because the talk leaderboard can move with no ledger change (a CV
    // re-read by a newer prompt surfaces talks that were always there), and because a write that
    // failed yesterday must still go out today even though today's scan found nothing new.
    const published =
      ctx.cvDigestPublisher && renderCvDigest(ctx).body_hash !== lastPublishedDigestHash(ctx)
        ? (
            await publishCvDigest(
              ctx,
              ctx.cvDigestPublisher,
              CV_SWEEP_ACTOR,
              scan.result.scanned_at,
            )
          ).ok
        : false;
    ctx.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: now.toISOString(),
      type: CV_SWEEP_EVENT,
      actor: CV_SWEEP_ACTOR,
      details: {
        scanned_at: scan.result.scanned_at,
        changed_members: changed,
        published,
        ...summarizeCvScan(scan.result.results),
      },
    });
    state.lastCompletedAt = now.toISOString();
    return { status: "done", changed_members: changed, published };
  } finally {
    cvSweepRunning = false;
    state.progress = undefined;
  }
}
