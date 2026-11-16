// Lab-wide paper sweeps and boards an administrator runs.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.

import { randomUUID } from "node:crypto";
import { parsePaperMentorRunInput } from "../../contracts/papermentor.js";
import { gatherOpenReviewPaperEvidence } from "../../workflows/papers/openreview-paper-sync-sources.js";
import {
  acceptanceRowCells,
  missingAcceptanceRows,
} from "../../workflows/papers/paper-outreach.js";
import {
  asString,
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendJson,
  sendServiceResult,
} from "../server.http.js";
import { pageOf, readPageQuery } from "../server.paging.js";
import {
  conferenceRosterWire,
  mailingExclusionsWire,
  mapPayload,
  nudgeBatchWire,
  slotOverviewWireRow,
} from "../server.paper-lists.wire.js";
import {
  adminSessionOnly,
  memberOnly,
  principalActor,
  privilegedOnly,
  requireMemberPrivileged,
} from "./guards.js";
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
        mapPayload(
          service.collectPublicationMailing({
            fromIso: url.searchParams.get("from") ?? "",
            toIso: url.searchParams.get("to") ?? "",
            ...(venue ? { venue } : {}),
          }),
          ({ excluded, ...digest }) => ({ ...digest, ...mailingExclusionsWire(excluded) }),
        ),
      );
    }),
  ),
  get(
    "/papers/outreach",
    privilegedOnly(({ res, url, ctx }) => {
      const venue = url.searchParams.get("venue")?.trim() ?? "";
      sendServiceResult(
        res,
        mapPayload(
          ctx.service.collectPaperOutreach({
            ...(venue ? { venue } : {}),
            config: ctx.outreachConfig,
          }),
          (payload) => ({
            ...payload,
            acceptance_sheet_configured: Boolean(ctx.acceptanceSheet),
          }),
        ),
      );
    }),
  ),
  post("/papers/outreach/send", async ({ req, res, ctx, principal }) => {
    // A member admin, like the digest send. Stricter than the digest in one way: the caller names
    // an outlet, never an address. Who an institute's newsletter is sent to is deployment
    // configuration, so a request cannot redirect the lab's acceptance news somewhere else.
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    if (!ctx.publicationMailingRunner) {
      sendJson(res, 503, { error: { message: "publication mailing is not configured" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const outlet = asString(body.outlet).trim();
    const requestedVenue = asString(body.venue).trim();
    if (!outlet || !requestedVenue) {
      sendJson(res, 400, { error: { message: "an outlet and a venue are required" } });
      return;
    }
    const outreach = ctx.service.collectPaperOutreach({
      venue: requestedVenue,
      config: ctx.outreachConfig,
    });
    if (!outreach.ok) {
      sendServiceResult(res, outreach);
      return;
    }
    const venue = outreach.payload.venue ?? requestedVenue;
    const draft = outreach.payload.drafts.find((entry) => entry.key === outlet);
    if (!draft) {
      sendJson(res, 404, { error: { message: `"${outlet}" is not an outreach outlet` } });
      return;
    }
    if (!draft.sendable) {
      // Recomputed here rather than trusted from the page: the reasons are the ones the preview
      // showed, and a stale page must not be able to mail a draft that has since stopped being
      // sendable (a paper lost its link, the recipients were removed).
      const reason =
        outreach.payload.config_error ??
        (draft.channel === "form"
          ? "this outlet is submitted through a form, not by email"
          : draft.channel === "doc"
            ? "this draft is an outline for a person to write, not an email"
            : draft.paper_ids.length === 0
              ? "no paper at this venue is for this outlet"
              : draft.to.length === 0
                ? "there is nobody to send this to: no recipients are configured or on the roster"
                : draft.needs_edit
                  ? "this draft has text left to write, so it can only be copied"
                  : "a paper in this draft has no link recorded");
      sendJson(res, 409, { error: { message: reason } });
      return;
    }
    const details = {
      outlet: draft.key,
      venue,
      recipients: draft.to,
      ...(draft.cc.length > 0 ? { cc: draft.cc } : {}),
      papers: draft.paper_ids,
    };
    try {
      await ctx.publicationMailingRunner({
        to: draft.to.join(","),
        ...(draft.cc.length > 0 ? { cc: draft.cc } : {}),
        subject: draft.subject,
        body: draft.body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        type: "paper_outreach.failed",
        actor: principalActor(principal),
        details: { ...details, reason: message },
      });
      sendJson(res, 502, { error: { message: `could not send the outreach email: ${message}` } });
      return;
    }
    ctx.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: "paper_outreach.sent",
      actor: principalActor(principal),
      details,
    });
    sendJson(res, 200, {
      sent: true,
      outlet: draft.key,
      venue,
      recipients: draft.to,
      cc: draft.cc,
      papers: draft.paper_ids.length,
    });
  }),
  post("/papers/outreach/summary", async ({ req, res, ctx, principal }) => {
    // Our own record, not an outside system, so it is written at once -- but by a member admin,
    // so the sentence that later goes out in the lab's name has somebody's name on its edit.
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    const paperId = asString(body.paper_id).trim();
    if (!paperId || typeof body.summary !== "string") {
      sendJson(res, 400, { error: { message: "a paper_id and a summary are required" } });
      return;
    }
    sendServiceResult(
      res,
      ctx.service.setPaperOutreachSummary(paperId, body.summary, {
        source: "admin",
        actor: principal.member.id,
      }),
    );
  }),
  post("/papers/outreach/acceptance-sheet", async ({ req, res, ctx, principal }) => {
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const sheet = ctx.acceptanceSheet;
    if (!sheet) {
      sendJson(res, 503, { error: { message: "the acceptance sheet is not configured" } });
      return;
    }
    // A check unless the caller says otherwise, so an empty body can never write to the sheet.
    const dryRun = readRecord(await readJsonOrEmpty(req)).dry_run !== false;
    const outreach = ctx.service.collectPaperOutreach({ config: ctx.outreachConfig });
    if (!outreach.ok) {
      sendServiceResult(res, outreach);
      return;
    }
    const fail = (status: number, message: string, added?: number) => {
      ctx.store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        type: "acceptance_sheet.failed",
        actor: principalActor(principal),
        details: { reason: message, dry_run: dryRun, ...(added === undefined ? {} : { added }) },
      });
      sendJson(res, status, { error: { message } });
    };
    let missing;
    try {
      // Read at the moment of writing, not taken from an earlier check: two admins pressing the
      // button a minute apart must not both add the same rows.
      missing = missingAcceptanceRows(outreach.payload.acceptance_rows, await sheet.read());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(502, `could not read the acceptance sheet: ${message}`);
      return;
    }
    if (!dryRun && missing.length > 0) {
      try {
        await sheet.append(missing.map(acceptanceRowCells));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(502, `could not add rows to the acceptance sheet: ${message}`, missing.length);
        return;
      }
      ctx.store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        type: "acceptance_sheet.rows_added",
        actor: principalActor(principal),
        details: { added: missing.length, papers: missing.map((row) => row.paper_id) },
      });
    }
    sendJson(res, 200, {
      dry_run: dryRun,
      total: outreach.payload.acceptance_rows.length,
      missing,
      added: dryRun ? 0 : missing.length,
    });
  }),
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
  // Paper records follow the PI's OpenReview submissions. Dry run unless the body says
  // `dry_run: false`, so a hand-run call reports before it writes; the six-hourly cron passes
  // false. The body may carry the author-results snapshot itself; otherwise the configured file
  // is read.
  post(
    "/papers/openreview-sync/run",
    privilegedOnly(async ({ req, res, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req, 26 * 1024 * 1024));
      const sources = await gatherOpenReviewPaperEvidence(ctx.openReviewPaperSources ?? {}, {
        ...(body.author_results !== undefined ? { author_results: body.author_results } : {}),
      });
      const result = service.syncPapersFromOpenReview({
        evidence: sources.evidence,
        dryRun: body.dry_run !== false,
      });
      sendServiceResult(
        res,
        result.ok
          ? {
              ...result,
              payload: { ...result.payload, sources: sources.read, warnings: sources.warnings },
            }
          : result,
      );
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
  // "Reviewed" on a My Desk row that is information rather than a decision, or its undo.
  post(
    "/papers/pi-review/ack",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const body = readRecord(await readJsonOrEmpty(req));
      if (typeof body.key !== "string" || typeof body.reviewed !== "boolean") {
        sendJson(res, 400, { error: { message: "send key (string) and reviewed (boolean)" } });
        return;
      }
      sendServiceResult(
        res,
        ctx.service.setPiReviewAck(principalActor(principal), {
          key: body.key,
          reviewed: body.reviewed,
        }),
      );
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
  // Ask PaperMentor to review the papers at their review step. Dry run unless the body says
  // `dry_run: false`, so a hand-run call names the papers before it asks for anything; the cron
  // passes false. Answers 503 on a live pass when no Overleaf secret is configured.
  post(
    "/papers/papermentor/reviews/run",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      const limit =
        typeof body.limit === "number" && Number.isInteger(body.limit)
          ? Math.min(Math.max(body.limit, 1), 20)
          : undefined;
      sendServiceResult(
        res,
        await service.requestPaperMentorReviews(
          principalActor(principal),
          ctx.paperMentorReviewRequester,
          { dryRun: body.dry_run !== false, ...(limit ? { limit } : {}) },
        ),
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
  post(
    /^\/papers\/conference-rosters\/([^/]+)\/intros$/u,
    adminSessionOnly(async ({ res, params, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        await service.introduceConferenceAttendees(decodeURIComponent(params[1])),
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
        mapPayload(
          service.collectPaperNudgeBatches(url.searchParams.get("now") ?? undefined),
          (p) => ({ ...p, batches: p.batches.map(nudgeBatchWire) }),
        ),
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
  // The weekday schedule's door. Service-callable, unlike the button above, and deliberately
  // without the recipient narrowing: the schedule sends every batch, recomputed from state, so the
  // service token chooses nothing -- the same reason the paperflow-stage pass below takes it. The
  // cron had been pointed at the session-only route and was refused with a 403 every weekday.
  post(
    "/papers/slot-reminder/scheduled-run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.sendPaperSlotNudges(principalActor(principal)));
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
    // One due nudge per stalled paper, so the list grows with the lab's projects. The board shows
    // 25 and pages; the metric and the chat panel's count read `total`.
    const page = readPageQuery(url, { defaultLimit: 25, maxLimit: 100 });
    sendServiceResult(
      res,
      mapPayload(service.listPaperNudges(url.searchParams.get("now") ?? undefined), (p) => {
        const { items, ...paging } = pageOf(p.nudges, page);
        return { ...p, nudges: items, ...paging };
      }),
    );
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
