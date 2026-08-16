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
 * Builds the Control UI URL a reset token is redeemed at. `adminBotUrl` pins the service the
 * Control UI talks back to: the token is only valid against the AdminBot that issued it, and the
 * Control UI is a static deployment that would otherwise fall back to whatever its build declared.
 */
export function buildPasswordResetUrl(params: {
  token: string;
  controlUiUrl?: string;
  adminBotUrl?: string;
}): string {
  const base = stripTrailingSlashes(params.controlUiUrl?.trim() || DEFAULT_ADMINBOT_CONTROL_UI_URL);
  const query = new URLSearchParams({ passwordReset: params.token });
  const adminBotUrl = params.adminBotUrl?.trim();
  if (adminBotUrl) {
    query.set("adminBotUrl", stripTrailingSlashes(adminBotUrl));
  }
  return `${base}/?${query.toString()}`;
}
