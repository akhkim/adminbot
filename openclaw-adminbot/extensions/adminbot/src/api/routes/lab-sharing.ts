// Collaborate: the lab-sharing directory and requests.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import { handleLabSharingRoute } from "../server.lab-sharing.js";
import { memberOnly } from "./guards.js";
import { route, type Route, under } from "./router.js";

export const labSharingRoutes: readonly Route[] = [
  route(
    "*",
    under("/lab-sharing"),
    memberOnly(
      async ({ req, res, url, ctx, principal }) => {
        const { service } = ctx;
        await handleLabSharingRoute(req, res, url, service, principal.member.id);
      },
      { status: 403, message: "A member session is required." },
    ),
  ),
];
