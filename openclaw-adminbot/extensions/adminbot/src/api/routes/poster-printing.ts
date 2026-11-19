// Poster print batches (kernel/service.poster-printing.ts). Who may do what is decided twice: the
// guard here says who may call at all, and the service decides per paper and per batch (an
// author answers for their own paper, the printer marks their own batch printed).
import type {
  AdminBotPosterPrintBatchInput,
  AdminBotPosterPrintRequestInput,
} from "../../contracts/poster-printing.js";
import { readJson, readJsonOrEmpty, readRecord, sendServiceResult } from "../server.http.js";
import { adminSessionOnly, isPrivileged, memberOnly, principalActor, privilegedOnly } from "./guards.js";
import { get, post, put, type Route } from "./router.js";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return undefined;
}

export const posterPrintingRoutes: readonly Route[] = [
  // Everyone signed in gets an answer; what it holds depends on who asks (see the service).
  get(
    "/poster-printing",
    memberOnly(({ res, principal, ctx }) => {
      sendServiceResult(
        res,
        ctx.service
          .posterPrinting()
          .overview({ memberId: principal.member.id, admin: isPrivileged(principal) }),
      );
    }),
  ),
  // The daily sweep's door: files reminders and print lists as proposals. Service-callable so the
  // cron can reach it; it chooses nothing, the sweep recomputes everything from state.
  post(
    "/poster-printing/scheduled-run",
    privilegedOnly(({ res, ctx }) => {
      sendServiceResult(res, ctx.service.posterPrinting().sweep());
    }),
  ),
  // Settings for one site, or the lab defaults under the key "default". An admin's own session.
  put(
    /^\/poster-printing\/([^/]+)$/u,
    adminSessionOnly(async ({ req, res, principal, ctx, params }) => {
      const body = readRecord(await readJson(req));
      const input: AdminBotPosterPrintBatchInput = {
        printer_member_id: optionalString(body.printer_member_id),
        print_location: optionalString(body.print_location),
        deadline_on: optionalString(body.deadline_on),
        lead_days: optionalNumber(body.lead_days),
        notes: optionalString(body.notes),
      };
      sendServiceResult(
        res,
        ctx.service
          .posterPrinting()
          .saveBatch(decodeURIComponent(params[1]!), input, principalActor(principal)),
      );
    }),
  ),
  post(
    /^\/poster-printing\/([^/]+)\/printed$/u,
    memberOnly(async ({ req, res, principal, ctx, params }) => {
      await readJsonOrEmpty(req);
      sendServiceResult(
        res,
        ctx.service.posterPrinting().markPrinted(decodeURIComponent(params[1]!), {
          memberId: principal.member.id,
          admin: isPrivileged(principal),
        }),
      );
    }),
  ),
  get(
    /^\/papers\/([^/]+)\/poster-print$/u,
    memberOnly(({ res, principal, ctx, params }) => {
      sendServiceResult(
        res,
        ctx.service.posterPrinting().paperOptions(decodeURIComponent(params[1]!), {
          memberId: principal.member.id,
          admin: isPrivileged(principal),
        }),
      );
    }),
  ),
  put(
    /^\/papers\/([^/]+)\/poster-print$/u,
    memberOnly(async ({ req, res, principal, ctx, params }) => {
      const body = readRecord(await readJson(req));
      const input = {
        choice: body.choice,
        site_key: optionalString(body.site_key),
        size: body.size,
        custom_size: optionalString(body.custom_size),
        orientation: body.orientation,
        copies: optionalNumber(body.copies),
        notes: optionalString(body.notes),
      } as AdminBotPosterPrintRequestInput;
      sendServiceResult(
        res,
        ctx.service.posterPrinting().setRequest(decodeURIComponent(params[1]!), input, {
          memberId: principal.member.id,
          admin: isPrivileged(principal),
        }),
      );
    }),
  ),
];
