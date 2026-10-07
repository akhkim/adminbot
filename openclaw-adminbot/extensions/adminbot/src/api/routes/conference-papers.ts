import { randomUUID } from "node:crypto";
// Published conference programmes: venue paper search, lab relevance, workshop nudges.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import { findRelevantLabPapers } from "../../workflows/papers/lab-relevance-search.js";
import {
  buildVenueIndex,
  refreshVenueIndexIfChanged,
  searchVenue,
  venuePaperCategories,
  venuePaperCategoryId,
} from "../../workflows/papers/venue-index.js";
import {
  asString,
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendJson,
  sendServiceResult,
} from "../server.http.js";
import {
  cancelWorkshopNudgeRun,
  listWorkshopConferences,
  readWorkshopNudgeRun,
  runScheduledWorkshopNudges,
  sendWorkshopNudges,
  startWorkshopNudgeRun,
} from "../server.workshop-nudges.js";
import { adminSessionOnly, principalActor, privilegedOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";

export const conferencePapersRoutes: readonly Route[] = [
  // Members: which conferences are searchable, and how fresh each index is. Member-level because
  // the whole point of the tool is that a member opens it; nothing here is about a person.
  get("/venue-papers/sources", ({ res, ctx }) => {
    const { service } = ctx;
    const settings = service.getSettings();
    const sources = settings.ok ? (settings.payload.venue_sources ?? []) : [];
    const statuses = new Map(
      ctx.store.listVenueIndexStatuses().map((status) => [status.venue_id, status]),
    );
    sendJson(res, 200, {
      // `indexed_at`/`embedding_model` are left undefined for a venue that has never been indexed
      // rather than conditionally spread in: JSON.stringify drops undefined values, so the wire
      // shape is the same and the object is built once instead of twice.
      sources: sources.map((source) => {
        const status = statuses.get(source.id);
        return {
          venue_id: source.id,
          label: source.label,
          paper_count: status?.paper_count ?? 0,
          indexed_at: status?.indexed_at,
          embedding_model: status?.embedding_model,
        };
      }),
    });
  }),
  get("/venue-papers/categories", ({ res, url, ctx }) => {
    const { service } = ctx;
    const venueId = url.searchParams.get("venue_id")?.trim() ?? "";
    const settings = service.getSettings();
    const source = (settings.ok ? (settings.payload.venue_sources ?? []) : []).find(
      (entry) => entry.id === venueId,
    );
    if (!source) {
      sendJson(res, 404, { error: { message: "that conference is not on the list" } });
      return;
    }
    sendJson(res, 200, {
      venue_id: venueId,
      categories: venuePaperCategories(ctx.store.listVenuePapers(venueId), source.label),
    });
  }),
  post("/venue-papers/search", async ({ req, res, ctx }) => {
    const { service } = ctx;
    // Open to visitors: see ANONYMOUS_ROUTES. The gate above admits anonymous callers only for the
    // routes named there, and applies the per-IP rate limit on the way through.
    const body = readRecord(await readJson(req));
    const venueId = asString(body.venue_id)?.trim() ?? "";
    const interests = asString(body.interests)?.trim() ?? "";
    const categoryId = asString(body.category_id)?.trim().toLowerCase() ?? "";
    if (!venueId) {
      sendJson(res, 400, { error: { message: "venue_id is required" } });
      return;
    }
    if (!interests) {
      sendJson(res, 400, { error: { message: "tell it what you work on first" } });
      return;
    }
    const settings = service.getSettings();
    const source = (settings.ok ? (settings.payload.venue_sources ?? []) : []).find(
      (entry) => entry.id === venueId,
    );
    // Only configured venues are searchable. Without this a member could name any OpenReview id
    // and read whatever happened to be indexed under it.
    if (!source) {
      sendJson(res, 404, { error: { message: "that conference is not on the list" } });
      return;
    }
    const rows = ctx.store.listVenuePapers(venueId);
    if (!rows.length) {
      sendJson(res, 409, {
        error: {
          message: `${source.label} has not been indexed yet — an admin can build it from the Cron tab`,
        },
      });
      return;
    }
    const categories = venuePaperCategories(rows, source.label);
    const category = categoryId ? categories.find((entry) => entry.id === categoryId) : undefined;
    if (categoryId && !category) {
      sendJson(res, 400, {
        error: { message: "that category is not available for this conference" },
      });
      return;
    }
    const selectedRows = categoryId
      ? rows.filter((row) => venuePaperCategoryId(row.venue, source.label) === categoryId)
      : rows;
    try {
      const ranking = await searchVenue({ rows: selectedRows, interests, embed: ctx.embedder });
      sendJson(res, 200, {
        venue_id: venueId,
        label: source.label,
        ...(category ? { category: category.label } : {}),
        searched: selectedRows.length,
        ...ranking,
      });
    } catch (error) {
      sendJson(res, 502, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }),
  // The lab's own papers, ranked against a topic or a whole proposal. See
  // workflows/papers/lab-relevance.ts.
  //
  // Deliberately *not* on ANONYMOUS_ROUTES, unlike the conference search directly above it. That
  // one ranks a published conference programme against text the caller typed, so it carries no lab
  // data; this one returns our paper titles, the sections they answer and how thin the record
  // behind each placement is. Same data as `GET /papers`, so it takes the same gate: the global
  // one, which admits only an authenticated caller.
  post("/lab-papers/relevance", async ({ req, res, ctx }) => {
    const { service } = ctx;
    const body = readRecord(await readJson(req));
    const query = asString(body.query)?.trim() ?? "";
    if (!query) {
      sendJson(res, 400, { error: { message: "say what to look for first" } });
      return;
    }
    const papers = service.listPapers();
    if (!papers.ok) {
      sendServiceResult(res, papers);
      return;
    }
    try {
      const report = await findRelevantLabPapers({
        papers: papers.payload.papers,
        query,
        embed: ctx.embedder,
      });
      sendJson(res, 200, report);
    } catch (error) {
      // The embedding model being unreachable is the common failure and it is not the caller's
      // fault, so it reads as a gateway error rather than a bad request.
      sendJson(res, 502, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }),
  post(
    "/workshop-nudges/preview",
    adminSessionOnly(({ res, ctx }) => {
      const { service } = ctx;
      // Reading is free and starts nothing. This used to run the whole match -- thousands of model
      // calls, tens of minutes -- inside the request, so opening the page began a pass nobody could
      // wait for. The answer of the last pass is what the page wants; producing a new one is a
      // separate, deliberate act below.
      sendJson(res, 200, readWorkshopNudgeRun(service));
    }),
  ),
  post(
    "/workshop-nudges/cancel",
    adminSessionOnly(({ res, principal, ctx }) => {
      const { service } = ctx;
      sendJson(
        res,
        200,
        cancelWorkshopNudgeRun({
          service,
          ...(principal.kind === "member" ? { actor: principal.member.id } : {}),
        }),
      );
    }),
  ),
  // Cheap on purpose -- it reads the generated deadline dataset and makes no model calls -- so the
  // page may ask for it on open, which is what lets the picker be populated before a pass is run.
  get(
    "/workshop-nudges/conferences",
    adminSessionOnly(({ res, ctx }) => {
      sendJson(res, 200, {
        conferences: listWorkshopConferences(ctx.workshopNudgeNow()),
      });
    }),
  ),
  post(
    "/workshop-nudges/refresh",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      // `force` is the administrator saying they have already decided the pass in flight is dead,
      // rather than waiting out the stall window that exists for the case where nobody is watching.
      const refreshBody = readRecord(await readJsonOrEmpty(req));
      try {
        sendJson(
          res,
          202,
          startWorkshopNudgeRun({
            service,
            match: ctx.workshopMatcher,
            now: ctx.workshopNudgeNow(),
            ...(refreshBody.force === true ? { force: true } : {}),
            ...(typeof refreshBody.conference_key === "string" && refreshBody.conference_key.trim()
              ? { conferenceKey: refreshBody.conference_key.trim() }
              : {}),
            ...(principal.kind === "member" ? { startedBy: principal.member.id } : {}),
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, message === "no upcoming workshop profiles are available" ? 409 : 502, {
          error: { message },
        });
      }
    }),
  ),
  post(
    "/workshop-nudges/send",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      const body = readRecord(await readJsonOrEmpty(req));
      const recipientMemberIds = Array.isArray(body.recipient_member_ids)
        ? body.recipient_member_ids
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
      if (!recipientMemberIds.length) {
        sendJson(res, 400, { error: { message: "recipient_member_ids must not be empty" } });
        return;
      }
      try {
        sendJson(
          res,
          200,
          await sendWorkshopNudges({
            service,
            match: ctx.workshopMatcher,
            now: ctx.workshopNudgeNow(),
            actor: principalActor(principal),
            recipientMemberIds,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, message === "no upcoming workshop profiles are available" ? 409 : 502, {
          error: { message },
        });
      }
    }),
  ),
  post(
    "/workshop-nudges/run",
    privilegedOnly(async ({ res, ctx, principal }) => {
      const { service } = ctx;
      try {
        sendJson(
          res,
          200,
          await runScheduledWorkshopNudges({
            service,
            match: ctx.workshopMatcher,
            now: ctx.workshopNudgeNow(),
            actor: principalActor(principal),
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, message === "no upcoming workshop profiles are available" ? 409 : 502, {
          error: { message },
        });
      }
    }),
  ),
  post(
    "/venue-papers/index",
    privilegedOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      if (!ctx.venuePapersReader) {
        sendJson(res, 503, {
          error: {
            message:
              "conference paper indexing is not configured — set OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD",
          },
        });
        return;
      }
      const readVenue = ctx.venuePapersReader;
      const settings = service.getSettings();
      const sources = settings.ok ? (settings.payload.venue_sources ?? []) : [];
      if (!sources.length) {
        sendJson(res, 409, {
          error: { message: "no conferences are configured — add one in Settings first" },
        });
        return;
      }
      // `changed_only` is the scheduled pass: rebuild a venue only when its accepted-paper list has
      // moved, which is how the index follows conference decisions instead of a calendar. Absent, or
      // false, this is the Tasks & Tools button and rebuilds everything unconditionally -- somebody
      // pressing it has a reason the count cannot see.
      // ...OrEmpty because the button posts no body at all, and "no body" means the unconditional
      // rebuild rather than a malformed request.
      const indexBody = readRecord(await readJsonOrEmpty(req));
      const changedOnly = indexBody.changed_only === true;
      const storedCounts = new Map(
        ctx.store.listVenueIndexStatuses().map((status) => [status.venue_id, status.paper_count]),
      );
      const built: unknown[] = [];
      const skipped: Array<{ venue_id: string; paper_count: number }> = [];
      const failed: Array<{ venue_id: string; reason: string }> = [];
      for (const source of sources) {
        try {
          const deps = {
            readVenue,
            embed: ctx.embedder,
            embeddingModel: ctx.embeddingModel,
            now: () => new Date(),
          };
          if (changedOnly) {
            const outcome = await refreshVenueIndexIfChanged(
              source,
              deps,
              storedCounts.get(source.id),
            );
            if (!outcome.changed) {
              skipped.push({ venue_id: outcome.venue_id, paper_count: outcome.paper_count });
              continue;
            }
            ctx.store.replaceVenueIndex(
              source.id,
              outcome.papers,
              outcome.result.indexed_at,
              outcome.result.embedding_model,
            );
            built.push(outcome.result);
            continue;
          }
          const { papers, result } = await buildVenueIndex(source, deps);
          // An empty venue is stored as empty rather than skipped: a conference whose decisions were
          // withdrawn should stop returning last year's papers.
          ctx.store.replaceVenueIndex(source.id, papers, result.indexed_at, result.embedding_model);
          built.push(result);
        } catch (error) {
          // One unreachable venue does not abort the rest: they are independent conferences, and a
          // whole-run abort would mean one bad id blocks every other index from refreshing.
          failed.push({
            venue_id: source.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      ctx.store.recordAudit({
        id: `aud_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        type: "venue_index.rebuilt",
        actor: principalActor(principal),
        details: { built: built.length, skipped: skipped.length, failed: failed.length },
      });
      sendJson(res, 200, { built, skipped, failed });
    }),
  ),
];
