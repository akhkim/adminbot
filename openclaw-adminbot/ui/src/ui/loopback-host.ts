// Control UI module answers one question several others need: is this host only reachable from the
// machine the browser itself runs on?
//
// It lives alone rather than in gateway.ts so boot-path modules (settings storage) can ask without
// pulling the WebSocket client into their chunk.

function isLoopbackIPv4Host(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

/** True for hosts that only resolve on the machine the browser itself runs on. */
export function isLoopbackGatewayHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    isLoopbackIPv4Host(normalized)
  );
}
