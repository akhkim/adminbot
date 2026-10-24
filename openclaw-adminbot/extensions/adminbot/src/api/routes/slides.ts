// The working-groups slide: an admin preview of what the next sync would do, and the button that
// turns that plan into a proposal. Neither writes to the deck -- the write happens only when an
// admin approves the `slides.sync_working_groups` proposal (see docs/operations/slides-working-groups.md).
import { renderWorkingGroupsPlanSvg } from "../../workflows/slides/face-layout-svg.js";
import { readJsonOrEmpty, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import { principalActor, privilegedOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";

export const slidesRoutes: readonly Route[] = [
  get(
    "/slides/working-groups/preview",
    privilegedOnly(async ({ res, url, ctx }) => {
      const result = await ctx.service.previewSlidesWorkingGroups();
      if (result.ok && url.searchParams.get("format") === "svg") {
        // The before/after picture, for a reviewer who wants to see the plan rather than read it.
        // Built from geometry and names only; no photo URL reaches the SVG.
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(renderWorkingGroupsPlanSvg(result.payload.plan, result.payload.page));
        return;
      }
      sendServiceResult(res, result);
    }),
  ),
  post(
    "/slides/working-groups/apply",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const body = readRecord(await readJsonOrEmpty(req));
      const trigger = body.trigger === undefined ? "manual" : body.trigger;
      // The weekly cron posts `schedule`; anything else is a person pressing the button. The
      // member-change trigger is internal to the service and cannot be claimed from outside.
      if (trigger !== "manual" && trigger !== "schedule") {
        sendJson(res, 400, { error: { message: 'trigger must be "manual" or "schedule"' } });
        return;
      }
      sendServiceResult(res, await ctx.service.syncSlidesWorkingGroups(principalActor(principal), trigger));
    }),
  ),
];
