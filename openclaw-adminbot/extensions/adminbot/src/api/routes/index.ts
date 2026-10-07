import { assistantRoutes } from "./assistant.js";
import { badgesRoutes } from "./badges.js";
import { calendarRoutes } from "./calendar.js";
import { conferencePapersRoutes } from "./conference-papers.js";
import { deadlinesRoutes } from "./deadlines.js";
import { directoryRoutes } from "./directory.js";
import { emailReviewRoutes } from "./email-review.js";
import { governanceRoutes } from "./governance.js";
import { labSharingRoutes } from "./lab-sharing.js";
import { logisticsRoutes } from "./logistics.js";
import { meetingsRoutes } from "./meetings.js";
import { membersRoutes } from "./members.js";
import { nudgesRoutes } from "./nudges.js";
import { onboardingRoutes } from "./onboarding.js";
import { paperAdminRoutes } from "./paper-admin.js";
import { papersRoutes } from "./papers.js";
import { profileRoutes } from "./profile.js";
import { reimbursementsRoutes } from "./reimbursements.js";
import { reviewsRoutes } from "./reviews.js";
// Every authenticated route, zone by zone, in the order the old if-chain tried them. No two zones
// claim the same method and path, so the zone order only has to keep each zone's own order.
import type { Route } from "./router.js";
import { workspaceRoutes } from "./workspace.js";

export const AUTHENTICATED_ROUTES: readonly Route[] = [
  ...profileRoutes,
  ...reviewsRoutes,
  ...deadlinesRoutes,
  ...emailReviewRoutes,
  ...directoryRoutes,
  ...conferencePapersRoutes,
  ...reimbursementsRoutes,
  ...governanceRoutes,
  ...calendarRoutes,
  ...assistantRoutes,
  ...workspaceRoutes,
  ...badgesRoutes,
  ...paperAdminRoutes,
  ...labSharingRoutes,
  ...membersRoutes,
  ...meetingsRoutes,
  ...papersRoutes,
  ...nudgesRoutes,
  ...logisticsRoutes,
  ...onboardingRoutes,
];
