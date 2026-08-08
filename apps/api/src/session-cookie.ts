const COOKIE_NAME = "adminbot_session_v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface SessionCookieOptions {
  readonly secure: boolean;
}

export function readSessionCookie(header: string | undefined): string | undefined {
  if (header === undefined || header.length > 8_192) return undefined;
  let value: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    if (value !== undefined) return undefined;
    const candidate = part.slice(separator + 1).trim();
    if (!TOKEN_PATTERN.test(candidate)) return undefined;
    value = candidate;
  }
  return value;
}

export function createSessionCookie(
  token: string,
  maximumAgeSeconds: number,
  options: SessionCookieOptions,
): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("session cookie token is invalid");
  if (!Number.isSafeInteger(maximumAgeSeconds) || maximumAgeSeconds < 1) {
    throw new Error("session cookie maximum age must be a positive integer");
  }
  return serializeCookie(token, `Max-Age=${maximumAgeSeconds}`, options);
}

export function clearSessionCookie(options: SessionCookieOptions): string {
  return serializeCookie("", "Max-Age=0", options);
}

function serializeCookie(
  value: string,
  lifetime: string,
  options: SessionCookieOptions,
): string {
  return [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    lifetime,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}
