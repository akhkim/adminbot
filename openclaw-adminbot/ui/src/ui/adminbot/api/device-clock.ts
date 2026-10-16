// The browser's own clock, sent with AdminBot requests so the server can tell a VPN exit city from
// where the member actually is. The zone name and the UTC offset only: no coordinates, nothing the
// member is asked for, and nothing the browser has to prompt for.

export const DEVICE_TZ_HEADER = "X-AdminBot-Device-TZ";
export const DEVICE_TZ_OFFSET_HEADER = "X-AdminBot-Device-TZ-Offset";

/** Headers describing this browser's clock; empty when the runtime cannot say. */
export function deviceClockHeaders(now: Date = new Date()): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && /^[A-Za-z0-9_+\-/]{1,64}$/u.test(zone)) {
      headers[DEVICE_TZ_HEADER] = zone;
    }
  } catch {
    // An Intl without zone support sends the offset alone.
  }
  // getTimezoneOffset is minutes *west* of UTC; the header is minutes east.
  const offset = -now.getTimezoneOffset();
  if (Number.isInteger(offset)) {
    headers[DEVICE_TZ_OFFSET_HEADER] = String(offset);
  }
  return headers;
}
