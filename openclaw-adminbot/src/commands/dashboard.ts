// Implements `openclaw dashboard` URL resolution, readiness check, clipboard, and browser launch.
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import {
  buildControlUiLaunchUrl,
  resolveControlUiLaunchUrl,
} from "../config/control-ui-launch-url.js";
import { resolveGatewayAuthToken } from "../gateway/auth/auth-token-resolution.js";
import { copyToClipboard } from "../infra/clipboard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { ensureGatewayReadyForOperation } from "./gateway/gateway-readiness.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard/onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
  yes?: boolean;
};

async function resolveDashboardTarget() {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;
  const configuredLaunchUrl = resolveControlUiLaunchUrl(cfg.gateway?.controlUi?.launchUrl);
  const resolvedToken = await resolveGatewayAuthToken({
    cfg,
    env: process.env,
    envFallback: "always",
  });
  const token = resolvedToken.token ?? "";

  // LAN URLs fail secure-context checks in browsers.
  // Coerce only lan->loopback and preserve other bind modes.
  const links = resolveControlUiLinks({
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost,
    basePath,
    tlsEnabled: cfg.gateway?.tls?.enabled === true,
  });
  const displayUrl = buildControlUiLaunchUrl({
    controlUiUrl: configuredLaunchUrl ?? links.httpUrl,
    gatewayUrl: configuredLaunchUrl ? links.wsUrl : undefined,
  });
  // Avoid embedding externally managed SecretRef tokens in terminal/clipboard/browser args.
  const includeTokenInUrl = token.length > 0 && !resolvedToken.secretRefConfigured;
  // Prefer URL fragment to avoid leaking auth tokens via query params.
  const dashboardUrl = buildControlUiLaunchUrl({
    controlUiUrl: configuredLaunchUrl ?? links.httpUrl,
    gatewayUrl: configuredLaunchUrl ? links.wsUrl : undefined,
    token: includeTokenInUrl ? token : undefined,
  });

  return {
    port,
    basePath,
    links,
    configuredLaunchUrl,
    displayUrl,
    resolvedToken,
    token,
    includeTokenInUrl,
    dashboardUrl,
  };
}

/** Open or print the Control UI dashboard URL after ensuring the Gateway is reachable. */
export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const initialTarget = await resolveDashboardTarget();
  const readiness = await ensureGatewayReadyForOperation({
    runtime,
    operation: "open the dashboard",
    yes: options.yes,
    probeUrl: initialTarget.links.wsUrl,
    readyWhenReachable: true,
  });
  if (!readiness.ready) {
    return;
  }

  const target = readiness.recovered ? await resolveDashboardTarget() : initialTarget;
  const {
    port,
    basePath,
    links,
    configuredLaunchUrl,
    displayUrl,
    resolvedToken,
    token,
    includeTokenInUrl,
    dashboardUrl,
  } = target;

  runtime.log(`Dashboard URL: ${displayUrl}`);
  if (configuredLaunchUrl) {
    runtime.log(`Gateway WebSocket URL: ${links.wsUrl}`);
  }
  if (includeTokenInUrl) {
    runtime.log("Token auto-auth included in browser/clipboard URL.");
  }
  if (resolvedToken.secretRefConfigured && token) {
    runtime.log(
      "Token auto-auth is disabled for SecretRef-managed gateway.auth.token; use your external token source if prompted.",
    );
  }
  if (resolvedToken.unresolvedRefReason) {
    runtime.log(`Token auto-auth unavailable: ${resolvedToken.unresolvedRefReason}`);
    runtime.log(
      "Set OPENCLAW_GATEWAY_TOKEN in this shell or resolve your secret provider, then rerun `openclaw dashboard`.",
    );
  }

  const copied = await copyToClipboard(dashboardUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(dashboardUrl);
    }
    if (!opened) {
      hint = configuredLaunchUrl
        ? "Browser launch unavailable. Open the Dashboard URL above from a browser that can reach the Gateway WebSocket URL."
        : formatControlUiSshHint({
            port,
            basePath,
          });
    }
  } else {
    hint =
      copied && includeTokenInUrl
        ? "Browser launch disabled (--no-open). Token-authenticated URL copied to clipboard."
        : "Browser launch disabled (--no-open). Use the URL above.";
  }

  const fallbackToManualAuth = !copied && !opened && includeTokenInUrl;
  const suppressNoOpenHint = options.noOpen === true && fallbackToManualAuth;

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control OpenClaw.");
  } else if (hint && !suppressNoOpenHint) {
    runtime.log(hint);
  }

  if (fallbackToManualAuth) {
    runtime.log(
      "Token auto-auth not delivered. Append your gateway token (from OPENCLAW_GATEWAY_TOKEN or gateway.auth.token) as a URL fragment with key `token` to authenticate.",
    );
  }
}
