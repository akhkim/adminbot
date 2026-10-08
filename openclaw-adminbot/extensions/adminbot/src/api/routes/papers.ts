// Paper records, their evidence slots, and the per-paper cycle.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import type { AdminBotPaperRecordInput } from "../../contracts/actions.js";
import type { AdminBotPaperSlotInput } from "../../contracts/paper-slots.js";
import { resolvePaperPdfSource } from "../../workflows/papers/paper-pdf-source.js";
import { readXAnnouncement, readXCredits } from "../../workflows/papers/x-draft.js";
import { asString, readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import {
  adminSessionOnly,
  isPrivileged,
  memberOnly,
  principalActor,
  privilegedOnly,
} from "./guards.js";
import { readListPage, limitParam } from "./query-params.js";
import { del, get, post, put, type Route } from "./router.js";

// 20 MB of PDF, plus base64's third and the JSON around it. Matches the Control UI's own check.
export const LINKEDIN_DRAFT_BODY_LIMIT_BYTES = Math.ceil(20 * 1024 * 1024 * 1.4);

export const papersRoutes: readonly Route[] = [
  get(/^\/papers\/([^/]+)\/recent-edits$/u, ({ res, url, principal, ctx, params }) => {
    const { service } = ctx;
    // The viewer goes to the service, which owns the ownership rule -- the same shape
    // GET /papers/:id/slots uses, so the history cannot become a way around the check the
    // checklist already makes.
    sendServiceResult(
      res,
      service.listRecentUpdatesForPaper(
        decodeURIComponent(params[1]!),
        {
          ...(principal.kind === "member" ? { memberId: principal.member.id } : {}),
          isAdmin: isPrivileged(principal),
        },
        limitParam(url),
      ),
    );
  }),
  // Generate a LinkedIn announcement draft. Deliberately NOT a proposal and NOT persisted:
  // the draft is a suggestion a human copies, edits and posts by hand, so storing it would
  // create a stale second copy of something whose only real version ends up on LinkedIn.
  // Nothing here writes -- the PDF is read, the post is returned, both are then forgotten.
  post(/^\/papers\/(?:linkedin|x)-draft$/u, async ({ req, res, url, ctx, principal }) => {
    const { service } = ctx;
    const isX = url.pathname === "/papers/x-draft";
    if (principal.kind === "anonymous") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    // A paper PDF can be attached here, so the default 1 MB JSON ceiling would refuse most real
    // papers once base64 has added its third.
    const body = readRecord(await readJson(req, LINKEDIN_DRAFT_BODY_LIMIT_BYTES));
    let announcement;
    let credits;
    if (isX) {
      try {
        announcement = readXAnnouncement(body.announcement);
        credits = readXCredits(body.credits);
      } catch (error) {
        sendJson(res, 400, { error: { message: (error as Error).message } });
        return;
      }
    }
    let pdfBase64 = typeof body.pdf_base64 === "string" ? body.pdf_base64 : "";
    // An upload is no longer required. The author has usually already given the lab this exact
    // file -- `drive_pdf_arxiv` is the Drive copy of the PDF they intend to post, and the card
    // chases them for it -- so asking them to find it again was asking for their own homework.
    // An uploaded file still wins: it is the one the person in front of the dialog chose.
    if (!pdfBase64) {
      const paperId = typeof body.paper_id === "string" ? body.paper_id : "";
      if (!paperId) {
        sendJson(res, 400, {
          error: { message: "attach a PDF, or send paper_id so the Drive copy can be used" },
        });
        return;
      }
      const cycle = service.listPaperSlots(paperId);
      if (!cycle.ok) {
        sendServiceResult(res, cycle);
        return;
      }
      const source = resolvePaperPdfSource(cycle.payload.slots, isX);
      if (source.kind === "none") {
        sendJson(res, 400, { error: { message: source.reason } });
        return;
      }
      if (source.kind === "arxiv") {
        try {
          pdfBase64 = await ctx.readArxivPdfBase64(source.id);
        } catch (error) {
          sendJson(res, 502, { error: { message: (error as Error).message } });
          return;
        }
        if (typeof body.url !== "string") {
          body.url = source.url;
        }
      } else {
        if (!ctx.readDrivePdfBase64) {
          sendJson(res, 503, {
            error: {
              message: "this deployment cannot read Drive files; attach the PDF here instead",
            },
          });
          return;
        }
        try {
          pdfBase64 = await ctx.readDrivePdfBase64(source.fileId);
        } catch (error) {
          sendJson(res, 502, {
            error: {
              message: `could not read the Drive copy (${(error as Error).message}); attach the PDF here instead`,
            },
          });
          return;
        }
        if (!pdfBase64) {
          sendJson(res, 502, {
            error: { message: "the Drive copy came back empty; attach the PDF here instead" },
          });
          return;
        }
      }
    }
    const membersResult = service.listLabMembers();
    const members = membersResult.ok ? membersResult.payload.members : [];
    try {
      const draft = await (isX ? ctx.draftXPost : ctx.draftLinkedInPost)({
        ...(announcement ? { announcement } : {}),
        ...(credits ? { credits } : {}),
        pdfBase64,
        members,
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.venue === "string" ? { venue: body.venue } : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      sendJson(res, 200, draft);
    } catch (error) {
      // The message names the missing env var or the extraction failure, and it is the only
      // thing the author can act on, so it is surfaced rather than swallowed into a 500.
      sendJson(res, 502, { error: { message: (error as Error).message } });
    }
  }),
  // A member's own active projects for the sidebar and the project cards. Member sessions only:
  // the service token has no "own" papers, and the id comes from the session, never the query.
  get(
    "/my/projects",
    memberOnly(
      ({ res, principal, ctx }) => {
        sendServiceResult(res, ctx.service.listMyProjects(principal.member.id));
      },
      { status: 403, message: "member session required" },
    ),
  ),
  get(
    "/papers/relevant",
    memberOnly(
      ({ res, principal, ctx }) => {
        const { service } = ctx;
        sendServiceResult(res, service.listPapersRelevantToMember(principal.member.id));
      },
      { status: 400, message: "member principal required" },
    ),
  ),
  get("/papers", ({ res, url, ctx }) => {
    const { service } = ctx;
    const page = readListPage(url);
    if (page === "invalid") {
      sendJson(res, 400, { error: { message: "invalid list pagination or search" } });
      return;
    }
    sendServiceResult(res, service.listPapers(page));
  }),
  get(
    "/papers/paperflow-stages",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.collectPaperflowStageNudges(url.searchParams.get("now") ?? undefined),
      );
    }),
  ),
  post(
    /^\/papers\/([^/]+)\/weekly-updates$/u,
    memberOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.savePaperWeeklyUpdate({
          paperId: decodeURIComponent(params[1]),
          memberId: principal.member.id,
          body: asString(body.body),
          ...(typeof body.week_start === "string" ? { weekStart: body.week_start } : {}),
        }),
      );
    }),
  ),
  get(/^\/papers\/([^/]+)\/weekly-updates$/u, ({ res, params, ctx }) => {
    const { service } = ctx;
    sendServiceResult(res, service.listPaperWeeklyUpdates(decodeURIComponent(params[1])));
  }),
  post(
    "/papers/paperflow-evidence",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.recordPaperflowEvidence({
          paperId: typeof body.paper_id === "string" ? body.paper_id : "",
          stage: typeof body.stage === "string" ? body.stage : "",
          actor: principalActor(principal),
          ...(typeof body.message_id === "string" ? { messageId: body.message_id } : {}),
          ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
          ...(typeof body.sender === "string" ? { sender: body.sender } : {}),
          ...(typeof body.confidence === "number" ? { confidence: body.confidence } : {}),
          // An admin closing a stage by hand is not held to the classifier's confidence floor --
          // they are the confirmation the floor exists to demand.
          ...(body.recorded_by === "admin" ? { recordedBy: "admin" as const } : {}),
        }),
      );
    }),
  ),
  put(/^\/papers\/([^/]+)\/slots\/([^/]+)$/u, async ({ req, res, principal, ctx, params }) => {
    const { service } = ctx;
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.setPaperSlot({
        paperId: decodeURIComponent(params[1]),
        slot: decodeURIComponent(params[2]),
        input: body as AdminBotPaperSlotInput,
        memberId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
  }),
  post(
    /^\/papers\/([^/]+)\/slots\/([^/]+)\/waive$/u,
    adminSessionOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = (await readJson(req)) as { reason?: string };
      sendServiceResult(
        res,
        service.waivePaperSlot({
          paperId: decodeURIComponent(params[1]),
          slot: decodeURIComponent(params[2]),
          reason: String(body?.reason ?? ""),
          memberId: principalActor(principal),
        }),
      );
    }),
  ),
  get(/^\/papers\/([^/]+)\/slots$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    // The viewer decides whether the arXiv password comes back at all -- authors and admins only.
    sendServiceResult(
      res,
      service.listPaperSlots(decodeURIComponent(params[1]), {
        ...(principal.kind === "member" ? { memberId: principal.member.id } : {}),
        isAdmin: isPrivileged(principal),
      }),
    );
  }),
  post(/^\/papers\/([^/]+)\/social-drafts$/u, async ({ req, res, principal, ctx, params }) => {
    const { service } = ctx;
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req, 3_000_000));
    sendServiceResult(
      res,
      service.saveSocialDraft({
        paperId: decodeURIComponent(params[1]),
        platform: String(body.platform ?? ""),
        body: String(body.body ?? ""),
        ...(body.x_thread !== undefined ? { xThread: body.x_thread } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        memberId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
  }),
  post(/^\/papers\/social-drafts\/([^/]+)\/circulate$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendServiceResult(
      res,
      service.circulateSocialDraft({
        draftId: decodeURIComponent(params[1]),
        memberId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
  }),
  post(
    /^\/papers\/social-drafts\/([^/]+)\/consent$/u,
    memberOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.recordSocialConsent({
          draftId: decodeURIComponent(params[1]),
          memberId: principal.member.id,
          decision: String(body.decision ?? ""),
          ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
        }),
      );
    }),
  ),
  del(
    /^\/conferences\/([^/]+)\/trip$/u,
    memberOnly(({ res, principal, params, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.withdrawConferenceTrip({
          conferenceKey: decodeURIComponent(params[1]),
          memberId: principal.member.id,
        }),
      );
    }),
  ),
  put(
    /^\/conferences\/([^/]+)\/trip$/u,
    memberOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.setConferenceTrip({
          conferenceKey: decodeURIComponent(params[1]),
          memberId: principal.member.id,
          intent: String(body.intent ?? ""),
          funding: String(body.funding ?? ""),
          needsLodging: body.needs_lodging === true,
          needsVisaLetter: body.needs_visa_letter === true,
          ...(typeof body.arrival_on === "string" ? { arrivalOn: body.arrival_on } : {}),
          ...(typeof body.departure_on === "string" ? { departureOn: body.departure_on } : {}),
          ...(typeof body.paper_id === "string" ? { paperId: body.paper_id } : {}),
          ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        }),
      );
    }),
  ),
  put(/^\/papers\/([^/]+)\/attendees$/u, async ({ req, res, principal, ctx, params }) => {
    const { service } = ctx;
    if (principal.kind !== "member" && !isPrivileged(principal)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.setConferenceAttendee({
        paperId: decodeURIComponent(params[1]),
        name: String(body.name ?? ""),
        ...(typeof body.member_id === "string" ? { memberId: body.member_id } : {}),
        attending: String(body.attending ?? ""),
        actorId: principal.kind === "member" ? principal.member.id : principalActor(principal),
        privileged: isPrivileged(principal),
      }),
    );
  }),
  put(
    /^\/papers\/([^/]+)\/reimbursements\/([^/]+)$/u,
    async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      if (principal.kind !== "member" && !isPrivileged(principal)) {
        sendJson(res, 401, { error: { message: "authentication required" } });
        return;
      }
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.setPaperReimbursement({
          paperId: decodeURIComponent(params[1]),
          memberId: decodeURIComponent(params[2]),
          status: String(body.status ?? ""),
          actorId: principal.kind === "member" ? principal.member.id : principalActor(principal),
          privileged: isPrivileged(principal),
        }),
      );
    },
  ),
  put(/^\/papers\/([^/]+)$/u, async ({ req, res, principal, ctx, params }) => {
    const { service } = ctx;
    const paperId = decodeURIComponent(params[1]);
    // Admins and automation write any paper. A plain member gets the narrower self-service path:
    // their own submissions only, and without the governance fields the paper flow owns.
    if (isPrivileged(principal)) {
      const body = (await readJson(req)) as AdminBotPaperRecordInput;
      // Automation principals have no member to name; they fall through as an unattributed write.
      sendServiceResult(
        res,
        service.upsertPaper(
          { ...body, id: paperId },
          principal.kind === "member" ? { source: "admin", actor: principal.member.id } : {},
        ),
      );
      return;
    }
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(res, service.upsertOwnPaper(principal.member.id, { ...body, id: paperId }));
  }),
  del(/^\/papers\/([^/]+)$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    const paperId = decodeURIComponent(params[1]);
    // Same split as the PUT above: an admin removes any paper, a member only one they authored.
    // Without the member branch the only way to undo a mistyped submission was to ask an admin.
    if (isPrivileged(principal)) {
      sendServiceResult(
        res,
        service.deletePaper(
          paperId,
          principal.kind === "member" ? { source: "admin", actor: principal.member.id } : {},
        ),
      );
      return;
    }
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendServiceResult(res, service.deleteOwnPaper(principal.member.id, paperId));
  }),
];
