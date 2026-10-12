// Notification Drafts (General Tools -> OpenReview To Tweet): announcement drafts generated from
// OpenReview acceptance notifications.
//
// It posts nothing and writes nothing (see docs/development/notification-drafts.md), so no
// proposal is involved. An administrator's own session is required, not the service token: the
// drafts are matched against the roster, and a person has to be the one asking.
import { adminSessionOnly } from "./guards.js";
import { post, type Route } from "./router.js";

export const notificationDraftsRoutes: readonly Route[] = [
  post(
    "/tools/notification-drafts",
    adminSessionOnly(async ({ req, res, ctx }) => {
      await ctx.notificationDrafts(req, res);
    }),
  ),
];
