// Helpers for launching a Control UI from a configured hosted URL.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const MAX_CONTROL_UI_LAUNCH_URL_LENGTH = 2048;

/** Normalize the configured external Control UI launch URL before validation/runtime use. */
export function normalizeControlUiLaunchUrl(value: string): string {
  return value.trim();
}

/** Validate the hosted Control UI URL that `openclaw dashboard` may open. */
export function isValidControlUiLaunchUrl(value: string): boolean {
  const normalized = normalizeControlUiLaunchUrl(value);
  if (!normalized || normalized.length > MAX_CONTROL_UI_LAUNCH_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    if (url.username || url.password || url.hash) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Resolve the optional custom Control UI URL from config. */
export function resolveControlUiLaunchUrl(value: string | null | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || !isValidControlUiLaunchUrl(normalized)) {
    return undefined;
  }
  return normalizeControlUiLaunchUrl(normalized);
}

/** Build the URL opened/copied for the Control UI, including Gateway routing/auth context. */
export function buildControlUiLaunchUrl(params: {
  controlUiUrl: string;
  gatewayUrl?: string;
  token?: string;
}): string {
  const url = new URL(params.controlUiUrl);
  const gatewayUrl = normalizeOptionalString(params.gatewayUrl);
  if (gatewayUrl) {
    url.searchParams.set("gatewayUrl", gatewayUrl);
  }
  const token = normalizeOptionalString(params.token);
  if (token) {
    const hashParams = new URLSearchParams(
      url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
    );
    hashParams.set("token", token);
    url.hash = hashParams.toString();
  }
  return url.toString();
}
