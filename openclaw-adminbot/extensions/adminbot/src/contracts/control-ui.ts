/**
 * Where this deployment's Control UI lives, and the links that have to land on it.
 *
 * The AdminBot service and the Control UI are two different origins: the service answers on
 * :8765 (fronted publicly by a tunnel) and serves the small built-in console at `/adminbot`, while
 * the Control UI is a separate static deployment. The console is deliberately a thin operator
 * surface — it has no way to redeem a password-reset token — so any link that expects a full
 * member flow has to name the Control UI, not whichever origin AdminBot happens to answer on.
 *
 * Resolution order, so a deployment that only ever set the older variable keeps working:
 *   1. ADMINBOT_CONTROL_UI_URL — the Control UI origin, and the one to set when it differs from
 *      the service origin.
 *   2. ADMINBOT_DASHBOARD_URL — the pre-existing "where do emails point" variable.
 *   3. The built-in default below.
 */

export const ADMINBOT_CONTROL_UI_URL_ENV = "ADMINBOT_CONTROL_UI_URL";
export const ADMINBOT_DASHBOARD_URL_ENV = "ADMINBOT_DASHBOARD_URL";

/** The lab has exactly one Control UI deployment, and member links have to land on it. */
export const DEFAULT_ADMINBOT_CONTROL_UI_URL = "https://jinesis-admin.vercel.app";

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/** The Control UI origin this deployment hands out, without a trailing slash. */
export function resolveAdminBotControlUiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured =
    env[ADMINBOT_CONTROL_UI_URL_ENV]?.trim() || env[ADMINBOT_DASHBOARD_URL_ENV]?.trim();
  return stripTrailingSlashes(configured || DEFAULT_ADMINBOT_CONTROL_UI_URL);
}

/**
 * Builds the Control UI URL a reset token is redeemed at.
 *
 * The token only — the service origin is deliberately not named here. An earlier version pinned
 * the Control UI back to the issuing AdminBot with an `adminBotUrl` parameter, which meant the
 * service host appeared in every member's inbox. The Control UI already knows which service it
 * talks to (its build declares one, and a member can override it in settings), so the parameter
 * bought nothing for the single-service deployment this lab runs.
 *
 * The trade-off, stated because it is real: a deployment running two AdminBot services would need
 * that pin back, or a token minted by one could land on a Control UI pointed at the other and be
 * rejected. One service, one Control UI — see DEFAULT_ADMINBOT_CONTROL_UI_URL above.
 */
export function buildPasswordResetUrl(params: { token: string; controlUiUrl?: string }): string {
  const base = stripTrailingSlashes(params.controlUiUrl?.trim() || DEFAULT_ADMINBOT_CONTROL_UI_URL);
  const query = new URLSearchParams({ passwordReset: params.token });
  return `${base}/?${query.toString()}`;
}
