#!/usr/bin/env node
// Forwards a loopback port on this box to a model server on the Aurora host over Tailscale.
//
// Every AdminBot path that sends raw private content to a model (the privacy broker, local chat,
// the guidebook, CV scanning, reimbursements, meetings) refuses a non-loopback endpoint, so a host
// whose model runs elsewhere needs a real loopback listener. Run one instance per model: vLLM on
// 8000, and Ollama embeddings on 11434 via ADMINBOT_TUNNEL_{LISTEN,TARGET}_PORT.
//
// This is a plain TCP relay, so the tailnet is the only thing encrypting the private prompts in
// transit. That is why both ends are checked before anything listens: the listener stays on
// loopback, or the relay would hand Aurora's model to whatever else can reach this box, and the
// target must be a Tailscale address, or a mis-set value would ship raw prompts across the
// internet in plaintext. Both fail closed.
import net from "node:net";

const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Whether `host` is a literal Tailscale address: IPv4 in the CGNAT range 100.64.0.0/10 that
 * Tailscale assigns from, or IPv6 in its fd7a:115c:a1e0::/48 prefix.
 *
 * Hostnames are refused, MagicDNS ones included: a name is resolved at connect time, and when the
 * tailnet is down it can resolve to something that is not the tailnet.
 */
export function isTailnetAddress(host) {
  if (net.isIPv4(host)) {
    const [first, second] = host.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  return net.isIPv6(host) && host.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function parsePort(raw, fallback, name) {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a port between 1 and 65535, got ${raw}`);
  }
  return value;
}

/** The validated tunnel settings, or a thrown error naming the setting that is wrong. */
export function resolveTunnelConfig(env) {
  const listenHost = env.ADMINBOT_TUNNEL_LISTEN_HOST?.trim() || "127.0.0.1";
  if (!LOOPBACK_LISTEN_HOSTS.has(listenHost)) {
    throw new Error(
      `ADMINBOT_TUNNEL_LISTEN_HOST must be loopback (127.0.0.1, ::1 or localhost), got ${listenHost}`,
    );
  }
  // The tailnet address of the model host. Deliberately has no default: it identifies one specific
  // machine, and a baked-in address would silently relay private traffic to whatever now answers it.
  // ADMINBOT_TUNNEL_TARGET_HOST is the old name for the same setting and is still accepted.
  const targetHost = (env.ADMINBOT_TUNNEL_TARGET ?? env.ADMINBOT_TUNNEL_TARGET_HOST ?? "").trim();
  if (!targetHost) {
    throw new Error(
      "ADMINBOT_TUNNEL_TARGET is not set — the tunnel has no model host to forward to. Set it to the tailnet address of the model server.",
    );
  }
  if (!isTailnetAddress(targetHost)) {
    throw new Error(
      `ADMINBOT_TUNNEL_TARGET must be a Tailscale IP address (100.64.0.0/10 or fd7a:115c:a1e0::/48), got ${targetHost}`,
    );
  }
  return {
    listenHost,
    listenPort: parsePort(env.ADMINBOT_TUNNEL_LISTEN_PORT, 8000, "ADMINBOT_TUNNEL_LISTEN_PORT"),
    targetHost,
    targetPort: parsePort(env.ADMINBOT_TUNNEL_TARGET_PORT, 8000, "ADMINBOT_TUNNEL_TARGET_PORT"),
  };
}

export function createTunnelServer({ targetHost, targetPort }, log = console) {
  return net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    // Either half closing tears down the pair; without this a failed connect leaks the client socket.
    const destroy = (error) => {
      if (error) {
        log.error(`tunnel error: ${error.message}`);
      }
      client.destroy();
      upstream.destroy();
    };
    client.on("error", destroy);
    upstream.on("error", destroy);
    client.on("close", destroy);
    upstream.on("close", destroy);
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

if (import.meta.main) {
  let config;
  try {
    config = resolveTunnelConfig(process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const server = createTunnelServer(config);
  server.on("error", (error) => {
    console.error(`tunnel listen failed: ${error.message}`);
    process.exit(1);
  });
  server.listen(config.listenPort, config.listenHost, () => {
    console.log(
      `AdminBot model tunnel: http://${config.listenHost}:${config.listenPort} -> ${config.targetHost}:${config.targetPort}`,
    );
  });
}
