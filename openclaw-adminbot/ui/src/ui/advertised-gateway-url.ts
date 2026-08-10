// Control UI module decides whether the gateway URL an auth service advertises may replace the
// one this page is already configured with.
//
// Signing in used to adopt the advertised URL unconditionally. An AdminBot that advertises its own
// loopback address — which is correct for a browser on the gateway host and wrong for every other
// browser — therefore replaced a working `wss://<host>` with `ws://127.0.0.1:18789` at the moment
// of sign-in. The browser then dialled its own machine, found nothing listening, and reported the
// refused socket as a bare `disconnected (1006): no reason`; only a reload (which re-applies the
// page's configured URL) recovered. The service knows its gateway token, not this browser's route
// to the gateway, so its advertisement is a suggestion the page may decline.
import { isLoopbackGatewayHost } from "./loopback-host.ts";

const GATEWAY_PROTOCOLS = new Set(["ws:", "wss:"]);

// Parsed without a base on purpose: a gateway URL is always absolute, and resolving a relative
// value against the page would turn junk like "not a url" into a same-origin URL that then looks
// routable.
function advertisedHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return GATEWAY_PROTOCOLS.has(parsed.protocol) ? parsed.hostname.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function pageHostname(href: string): string | null {
  try {
    return new URL(href).hostname.trim().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns the gateway URL to connect with. Falls back to `current` when the advertised URL is
 * absent, unusable, or a loopback address this page could not reach.
 */
export function resolveAdvertisedGatewayUrl(params: {
  advertised: string | undefined;
  current: string;
  pageHref?: string;
}): string {
  const advertised = params.advertised?.trim();
  if (!advertised) {
    return params.current;
  }
  const advertisedHost = advertisedHostname(advertised);
  if (!advertisedHost) {
    return params.current;
  }
  if (!isLoopbackGatewayHost(advertisedHost)) {
    return advertised;
  }
  // Loopback is genuinely correct when the Control UI is itself served from the gateway host, which
  // is the local `openclaw dashboard` case — keep honouring it there.
  const pageHost = params.pageHref ? pageHostname(params.pageHref) : null;
  return pageHost && isLoopbackGatewayHost(pageHost) ? advertised : params.current;
}
