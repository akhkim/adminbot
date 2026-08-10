/**
 * SSRF-guarded provider fetch.
 *
 * Every provider that talks to a remote API goes through this helper, so it carries the
 * proxy-vs-pinned-DNS policy in one place. It used to live in media-understanding/shared.ts
 * despite having nothing to do with media; that module went with the media subsystems.
 */
import type { GuardedFetchMode, GuardedFetchResult } from "./fetch-guard.js";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "./fetch-guard.js";
import { shouldUseEnvHttpProxyForUrl } from "./proxy-env.js";
import type { LookupFn, PinnedDispatcherPolicy, SsrFPolicy } from "./ssrf.js";

const DEFAULT_GUARDED_HTTP_TIMEOUT_MS = 60_000;
const MAX_AUDIT_CONTEXT_CHARS = 80;

function resolveGuardedHttpTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_GUARDED_HTTP_TIMEOUT_MS;
  }
  return timeoutMs;
}

function sanitizeAuditContext(auditContext: string | undefined): string | undefined {
  const cleaned = auditContext
    ?.replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.slice(0, MAX_AUDIT_CONTEXT_CHARS);
}

function shouldAutoUpgradeToTrustedEnvProxy(params: {
  url: string;
  dispatcherPolicy: PinnedDispatcherPolicy | undefined;
}): boolean {
  if (params.dispatcherPolicy) {
    return false;
  }

  return shouldUseEnvHttpProxyForUrl(params.url);
}

export async function fetchWithTimeoutGuarded(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  fetchFn: typeof fetch,
  options?: {
    ssrfPolicy?: SsrFPolicy;
    lookupFn?: LookupFn;
    pinDns?: boolean;
    dispatcherPolicy?: PinnedDispatcherPolicy;
    auditContext?: string;
    mode?: GuardedFetchMode;
  },
): Promise<GuardedFetchResult> {
  // Provider HTTP helpers (image/music/video generation, transcription, etc.)
  // call this function from every provider that talks to a remote API. When
  // the host has HTTP_PROXY/HTTPS_PROXY configured, the lower-level strict
  // mode would force Node-level `dns.lookup()` on the target hostname before
  // dialing the proxy — which fails with EAI_AGAIN in proxy-only environments
  // (containers, restricted sandboxes, corporate networks with DNS-over-proxy,
  // Clash TUN fake-IP, etc.). Auto-upgrade to trusted env proxy mode in that
  // case so the request goes through the configured proxy agent instead of
  // doing a local DNS pre-resolution.
  //
  // This does not weaken SSRF protection when the auto-upgrade fires: an HTTP
  // CONNECT proxy on the egress path performs hostname resolution itself and
  // client-side DNS pinning cannot meaningfully constrain the target IP. But
  // the auto-upgrade is gated (see `shouldAutoUpgradeToTrustedEnvProxy`) to
  // avoid three SSRF-bypass edge cases: caller-provided `dispatcherPolicy`,
  // `ALL_PROXY`-only envs, and `NO_PROXY` target matches. Callers that
  // explicitly need strict pinned-DNS can still opt in by passing
  // `mode: GUARDED_FETCH_MODE.STRICT` here or by using `fetchWithSsrFGuard`
  // directly.
  //
  // See openclaw#52162 for the reported failure mode on memory embeddings,
  // which shares this code path with image/music/video/audio generation.
  const resolvedMode =
    options?.mode ??
    (shouldAutoUpgradeToTrustedEnvProxy({
      url,
      dispatcherPolicy: options?.dispatcherPolicy,
    })
      ? GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY
      : undefined);
  return await fetchWithSsrFGuard({
    url,
    fetchImpl: fetchFn,
    init,
    timeoutMs: resolveGuardedHttpTimeoutMs(timeoutMs),
    policy: options?.ssrfPolicy,
    lookupFn: options?.lookupFn,
    pinDns: options?.pinDns,
    dispatcherPolicy: options?.dispatcherPolicy,
    auditContext: sanitizeAuditContext(options?.auditContext),
    ...(resolvedMode ? { mode: resolvedMode } : {}),
  });
}
