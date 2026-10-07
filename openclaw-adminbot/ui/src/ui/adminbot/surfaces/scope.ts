// The one shape every AdminBot surface is rendered with.
//
// A surface is a tab's whole presence on the page: it decides whether its tab is showing, wires the
// view's callbacks to the controllers, and returns `nothing` otherwise. renderApp resolves the
// values below once per render -- who is looking, what is still loading -- and hands the same
// object to every surface, so no surface recomputes them and none can disagree with another.
import type { TemplateResult, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import type { AccessRole } from "../access.ts";
import type { AdminBotLoadMode, AdminBotPaperRecord } from "../controllers/admin.ts";
import type { AdminBotPanel } from "../views/admin.ts";
import type { LogisticsTemplate } from "../views/logistics.ts";

export type AdminBotSurfaceScope = {
  accessRole: AccessRole;
  adminBotMode: AdminBotLoadMode;
  /** The admin panel this tab opens, if it is one of the panel tabs. */
  adminBotPanel: AdminBotPanel | null;
  /** The paper Active Papers has opened as a card, resolved from its id on this render. */
  activePaperCard: AdminBotPaperRecord | undefined;
  hasMemberSession: boolean;
  needsPapersForTab: boolean;
  /** The roster this tab reads has not arrived yet, so the tab holds back rather than half-render. */
  rosterPendingForTab: boolean;
  logisticsTemplate: LogisticsTemplate;
  logisticsScope: string;
  /** A member with required profile fields still empty: only My Profile works until they are filled. */
  profileBlocked: boolean;
  requestHostUpdate: (() => void) | undefined;
};

export type AdminBotSurface = (
  state: AppViewState,
  scope: AdminBotSurfaceScope,
) => TemplateResult | typeof nothing;
