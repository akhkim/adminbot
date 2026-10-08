// Lab-wide paper sweeps and boards an administrator runs.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.

import { randomUUID } from "node:crypto";
import { parsePaperMentorRunInput } from "../../contracts/papermentor.js";
import {
  asString,
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendJson,
  sendServiceResult,
} from "../server.http.js";
import {
  adminSessionOnly,
  memberOnly,
  principalActor,
  privilegedOnly,
  requireMemberPrivileged,
} from "./guards.js";
import {
  conferenceRosterWire,
  mapPayload,
  slotOverviewWireRow,
} from "../server.paper-lists.wire.js";
import { get, post, type Route } from "./router.js";

export const paperAdminRoutes: readonly Route[] = [
  post(
    "/papers/import/columns",
    memberOnly(async ({ req, res, ctx }) => {
      const body = readRecord(await readJson(req));
      const unmapped = Array.isArray(body.unmapped)
        ? body.unmapped.flatMap((entry) => {
            const record = readRecord(entry);
            const header = asString(record.header);
            if (!header) {
              return [];
            }
            const samples = Array.isArray(record.samples)
              ? record.samples.flatMap((value) => (typeof value === "string" ? [value] : []))
              : [];
            return [{ header, samples }];
          })
        : [];
      const available = Array.isArray(body.available)
        ? body.available.flatMap((value) => (typeof value === "string" ? [value] : []))
        : [];
      const mapper = ctx.importColumnMapper;
      if (!mapper) {
        // The local pass has already produced a usable mapping, so no model is a smaller answer
        // rather than an error.
        sendJson(res, 200, { mapping: {} });
        return;
      }
      sendJson(res, 200, { mapping: await mapper({ unmapped, available }) });
    }),
  ),
  get(
    "/papers/mailing-list",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      // `venue` composes by acceptance instead of by date; the payload always carries the venue
      // options, so one preview call is enough to fill the picker and read the digest.
      const venue = url.searchParams.get("venue")?.trim() ?? "";
      sendServiceResult(
        res,
        service.collectPublicationMailing({
          fromIso: url.searchParams.get("from") ?? "",
          toIso: url.searchParams.get("to") ?? "",
          ...(venue ? { venue } : {}),
        }),
      );
    }),
  ),
  post("/papers/mailing-list/send", async ({ req, res, ctx, principal }) => {
    const { service } = ctx;
    // requireMemberPrivileged, not requirePrivileged: the caller names the recipient, so this is
    // an admin-composed send to an arbitrary address and the shared service principal is kept out
    // of it. The same reasoning as /lab/members/merge and /nudges/send.
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    if (!ctx.publicationMailingRunner) {
      sendJson(res, 503, { error: { message: "publication mailing is not configured" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const recipient = asString(body.email).trim();
    if (!recipient.includes("@")) {
      sendJson(res, 400, { error: { message: "a recipient email address is required" } });
      return;
    }
    const venue = asString(body.venue).trim();
    const digest = service.collectPublicationMailing({
      fromIso: asString(body.from),
      toIso: asString(body.to),
      ...(venue ? { venue } : {}),
    });
    if (!digest.ok) {
      sendServiceResult(res, digest);
      return;
    }
    try {
      await ctx.publicationMailingRunner({
        to: recipient,
        subject: digest.payload.subject,
        body: digest.payload.body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        type: "publication_digest.failed",
        actor: principalActor(principal),
        details: {
          recipient,
          from: digest.payload.from,
          to: digest.payload.to,
          ...(venue ? { venue } : {}),
          reason: message,
        },
      });
      sendJson(res, 502, { error: { message: `could not send the digest: ${message}` } });
      return;
    }
    ctx.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: "publication_digest.sent",
      actor: principalActor(principal),
      details: {
        recipient,
        from: digest.payload.from,
        to: digest.payload.to,
        // Which composition this was, so a trail of sends to the same address can be told apart:
        // "the 2026 list" and "the ICLR 2027 list" are different emails.
        ...(digest.payload.venue ? { venue: digest.payload.venue } : {}),
        // The count, so the trail says what went out without storing the whole list twice.
        publications: digest.payload.publications.length,
        undated: digest.payload.undated_count,
      },
    });
    sendJson(res, 200, {
      sent: true,
      recipient,
      ...(digest.payload.venue ? { venue: digest.payload.venue } : {}),
      publications: digest.payload.publications.length,
      undated_count: digest.payload.undated_count,
    });
  }),
  get("/papers/slot-overview", ({ res, url, ctx }) => {
    const { service } = ctx;
    // Read-only, and the same records GET /papers already returns to any signed-in member -- this
    // just adds what is outstanding on each. The write and the send below are the gated halves.
    sendServiceResult(
      res,
      mapPayload(service.listPaperSlotOverview(url.searchParams.get("now") ?? undefined), (p) => ({
        papers: p.papers.map(slotOverviewWireRow),
      })),
    );
  }),
  post(
    "/papers/evidence/verify/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.verifyPaperEvidence(principalActor(principal)));
    }),
  ),
  post(
    "/papers/stages/run",
    privilegedOnly(({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.syncPaperStages(principalActor(principal)));
    }),
  ),
  get(
    "/papers/pi-review",
    privilegedOnly(({ res, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listPiReviewQueue());
    }),
  ),
  post(
    "/papers/papermentor/runs",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const run = parsePaperMentorRunInput(await readJsonOrEmpty(req));
      if (!run) {
        sendJson(res, 400, {
          error: { message: "a PaperMentor run needs at least project_id and reviewed_at" },
        });
        return;
      }
      sendServiceResult(res, service.recordPaperMentorRun(principalActor(principal), run));
    }),
  ),
  get(
    "/papers/papermentor/runs",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.listPaperMentorRuns(url.searchParams.get("paper_id") ?? undefined),
      );
    }),
  ),
  post(
    /^\/papers\/conference-rosters\/([^/]+)\/channel-invites$/u,
    adminSessionOnly(async ({ res, params, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        await service.inviteConferenceAttendees(decodeURIComponent(params[1])),
      );
    }),
  ),
  get(
    "/papers/conference-travel-export",
    privilegedOnly(({ res, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listConferenceTravelExport());
    }),
  ),
  get(
    "/papers/conference-rosters",
    privilegedOnly(({ res, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        mapPayload(service.listConferenceRosters(), (p) => ({
          conferences: p.conferences.map(conferenceRosterWire),
        })),
      );
    }),
  ),
  get(
    "/papers/nudge-batches",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.collectPaperNudgeBatches(url.searchParams.get("now") ?? undefined),
      );
    }),
  ),
  post(
    "/papers/slot-reminder/run",
    adminSessionOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      // An empty body is the ordinary case: "send every batch". Only a caller narrowing the send to
      // people picked out of the preview sends anything at all, so requiring a body here would make
      // the plain press the awkward one.
      const body = readRecord(await readJsonOrEmpty(req));
      const recipients = Array.isArray(body.recipient_member_ids)
        ? body.recipient_member_ids.filter((id): id is string => typeof id === "string")
        : undefined;
      sendServiceResult(
        res,
        await service.sendPaperSlotNudges(principalActor(principal), {
          ...(recipients?.length ? { recipientIds: recipients } : {}),
        }),
      );
    }),
  ),
  post(
    "/papers/paperflow-stages/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.sendPaperflowStageNudges(principalActor(principal)));
    }),
  ),
  get(
    "/papers/weekly-updates/pending",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.collectWeeklyUpdateGaps(url.searchParams.get("now") ?? undefined),
      );
    }),
  ),
  get(
    "/papers/pre-registration/pending",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.collectPreRegistrationNudges({
          ...(url.searchParams.get("venue")
            ? { venue: url.searchParams.get("venue") as string }
            : {}),
          ...(url.searchParams.get("now") ? { nowIso: url.searchParams.get("now") as string } : {}),
        }),
      );
    }),
  ),
  post(
    "/papers/pre-registration/run",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      sendServiceResult(
        res,
        await service.sendPreRegistrationNudges(principalActor(principal), {
          ...(typeof body.venue === "string" ? { venue: body.venue } : {}),
          ...(typeof body.now === "string" ? { nowIso: body.now } : {}),
          ...(body.force === true ? { force: true } : {}),
        }),
      );
    }),
  ),
  post(
    "/papers/weekly-updates/run",
    privilegedOnly(async ({ res, url, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        await service.sendWeeklyUpdateNudges(
          principalActor(principal),
          url.searchParams.get("now") ?? undefined,
        ),
      );
    }),
  ),
  post(
    "/papers/slots/backfill",
    adminSessionOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = (await readJson(req)) as { dry_run?: boolean; quiet_days?: number };
      sendServiceResult(
        res,
        service.backfillPaperSlots(principalActor(principal), {
          dryRun: body?.dry_run === true,
          ...(typeof body?.quiet_days === "number" ? { quietDays: body.quiet_days } : {}),
        }),
      );
    }),
  ),
  get("/papers/nudges", ({ res, url, ctx }) => {
    const { service } = ctx;
    sendServiceResult(res, service.listPaperNudges(url.searchParams.get("now") ?? undefined));
  }),
  post(
    "/papers/author-links/backfill",
    adminSessionOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      sendServiceResult(
        res,
        service.backfillPaperAuthorLinks({
          actor: principalActor(principal),
          dryRun: body.dry_run !== false,
        }),
      );
    }),
  ),
  post(
    "/papers/project-channels/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.syncProjectChannels(principalActor(principal)));
    }),
  ),
];
