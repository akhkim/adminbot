// Control UI content-security-policy helpers.
// Computes inline script hashes and builds the Gateway-served CSP header.
import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const SCRIPT_ATTRIBUTE_NAME_RE = /\s([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

/**
 * Compute SHA-256 CSP hashes for inline `<script>` blocks in an HTML string.
 * Only scripts without a `src` attribute are considered inline.
 */
export function computeInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const openTag = match[0].slice(0, match[0].indexOf(">") + 1);
    if (hasScriptSrcAttribute(openTag)) {
      continue;
    }
    const content = match[1];
    if (!content) {
      continue;
    }
    const hash = createHash("sha256").update(content, "utf8").digest("base64");
    hashes.push(`sha256-${hash}`);
  }
  return hashes;
}

function hasScriptSrcAttribute(openTag: string): boolean {
  return Array.from(openTag.matchAll(SCRIPT_ATTRIBUTE_NAME_RE)).some(
    (match) => normalizeLowercaseStringOrEmpty(match[1]) === "src",
  );
}

/** Only well-formed http(s)/ws(s) origins (or a `scheme://*:port` port-wildcard form) are
 *  accepted into connect-src — a malformed config value must not corrupt the CSP header. */
function isValidConnectSrcOrigin(origin: string): boolean {
  const trimmed = origin.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(https?|wss?):\/\/\*:\d+$/.test(trimmed)) {
    return true;
  }
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/** Build the CSP header applied to Gateway-served Control UI HTML. */
export function buildControlUiCspHeader(opts?: {
  inlineScriptHashes?: string[];
  extraConnectSrc?: string[];
}): string {
  const hashes = opts?.inlineScriptHashes;
  const scriptSrc = hashes?.length
    ? `script-src 'self' ${hashes.map((h) => `'${h}'`).join(" ")}`
    : "script-src 'self'";
  const extraOrigins = Array.from(
    new Set((opts?.extraConnectSrc ?? []).filter(isValidConnectSrcOrigin)),
  );
  const connectSrc = [
    "connect-src 'self' ws: wss: https://api.openai.com https://tweakcn.com",
    ...extraOrigins,
  ].join(" ");
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    "worker-src 'self'",
    connectSrc,
  ].join("; ");
}
