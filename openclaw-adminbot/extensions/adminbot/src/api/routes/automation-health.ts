// The automation health check: is every scheduled job still running, and is what it does working.
//
// All three are service-callable. The heartbeat is posted by every cron run (scripts/lib/
// adminbot-cron-run.sh), the run is itself a cron job, and the read is what a dashboard polls; none
// takes anything from the caller that chooses who hears what.
import { readJsonOrEmpty, readRecord, sendServiceResult } from "../server.http.js";
import { principalActor, privilegedOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";

export const automationHealthRoutes: readonly Route[] = [
  get(
    "/automation/health",
    privilegedOnly(({ res, ctx }) => {
      sendServiceResult(res, ctx.service.automationHealth());
    }),
  ),
  post(
    "/automation/health/heartbeat",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const body = readRecord(await readJsonOrEmpty(req));
      sendServiceResult(res, ctx.service.recordAutomationHeartbeat(principalActor(principal), body));
    }),
  ),
  post(
    "/automation/health/run",
    privilegedOnly(({ res, principal, ctx }) => {
      sendServiceResult(res, ctx.service.raiseAutomationHealthAlerts(principalActor(principal)));
    }),
  ),
];
