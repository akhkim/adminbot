// My Info: the member Travel tab -- conference RSVPs, travel plans and opt-in location sharing.
//
// A member session only: the service principal is the agent, and nothing about where members are
// -- or are going -- is the agent's to read. The service then narrows to full members and applies
// the sharing opt-in (kernel/service.lab-travel.ts).
import { handleTravelRoute } from "../server.travel.js";
import { memberOnly } from "./guards.js";
import { route, type Route, under } from "./router.js";

export const travelRoutes: readonly Route[] = [
  route(
    "*",
    under("/travel"),
    memberOnly(
      async ({ req, res, url, ctx, principal }) => {
        await handleTravelRoute(req, res, url, ctx.service, principal.member.id);
      },
      { status: 403, message: "A member session is required." },
    ),
  ),
];
