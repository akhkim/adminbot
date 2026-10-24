// Model tunnel tests cover the fail-closed checks on both ends and the relay itself.
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTunnelServer,
  isTailnetAddress,
  resolveTunnelConfig,
} from "../../scripts/adminbot-model-tunnel.mjs";

const TARGET = "100.101.102.103";

describe("isTailnetAddress", () => {
  it("accepts Tailscale IPv4 and IPv6 addresses", () => {
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.127.255.254")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetAddress("FD7A:115C:A1E0:AB12:4843:CD96:6258:B240")).toBe(true);
  });

  it("refuses public, private-LAN and just-outside-range addresses", () => {
    expect(isTailnetAddress("100.63.255.255")).toBe(false);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("3.221.59.247")).toBe(false);
    expect(isTailnetAddress("10.0.0.5")).toBe(false);
    expect(isTailnetAddress("fd7a:115c:a1e1::1")).toBe(false);
  });

  it("refuses hostnames, MagicDNS included, because they resolve at connect time", () => {
    expect(isTailnetAddress("aurora.tail1234.ts.net")).toBe(false);
    expect(isTailnetAddress("aurora")).toBe(false);
  });
});

describe("resolveTunnelConfig", () => {
  it("defaults to loopback 8000 -> target 8000", () => {
    expect(resolveTunnelConfig({ ADMINBOT_TUNNEL_TARGET: TARGET })).toEqual({
      listenHost: "127.0.0.1",
      listenPort: 8000,
      targetHost: TARGET,
      targetPort: 8000,
    });
  });

  it("forwards a second model port and still accepts the old target name", () => {
    expect(
      resolveTunnelConfig({
        ADMINBOT_TUNNEL_TARGET_HOST: TARGET,
        ADMINBOT_TUNNEL_LISTEN_HOST: "::1",
        ADMINBOT_TUNNEL_LISTEN_PORT: "11434",
        ADMINBOT_TUNNEL_TARGET_PORT: "11434",
      }),
    ).toEqual({ listenHost: "::1", listenPort: 11434, targetHost: TARGET, targetPort: 11434 });
  });

  it("refuses a missing target", () => {
    expect(() => resolveTunnelConfig({})).toThrow("ADMINBOT_TUNNEL_TARGET is not set");
  });

  it("refuses a target off the tailnet", () => {
    expect(() => resolveTunnelConfig({ ADMINBOT_TUNNEL_TARGET: "3.221.59.247" })).toThrow(
      "must be a Tailscale IP address",
    );
  });

  it("refuses a listener that is not loopback", () => {
    for (const host of ["0.0.0.0", "::", "10.42.1.78"]) {
      expect(() =>
        resolveTunnelConfig({ ADMINBOT_TUNNEL_TARGET: TARGET, ADMINBOT_TUNNEL_LISTEN_HOST: host }),
      ).toThrow("ADMINBOT_TUNNEL_LISTEN_HOST must be loopback");
    }
  });

  it("refuses an invalid port", () => {
    expect(() =>
      resolveTunnelConfig({ ADMINBOT_TUNNEL_TARGET: TARGET, ADMINBOT_TUNNEL_LISTEN_PORT: "0" }),
    ).toThrow("ADMINBOT_TUNNEL_LISTEN_PORT must be a port");
    expect(() =>
      resolveTunnelConfig({ ADMINBOT_TUNNEL_TARGET: TARGET, ADMINBOT_TUNNEL_TARGET_PORT: "http" }),
    ).toThrow("ADMINBOT_TUNNEL_TARGET_PORT must be a port");
  });
});

describe("createTunnelServer", () => {
  const servers: net.Server[] = [];
  const quietLog = { error() {} };

  function listen(server: net.Server): Promise<number> {
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  // Writes without half-closing, as an HTTP client does: the relay tears down both sides on the
  // first close, so a client that ended its side first would never see the reply.
  function roundTrip(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
      let received = "";
      socket.on("data", (chunk) => (received += chunk));
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
    });
  }

  function close(server: net.Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it("relays bytes both ways", async () => {
    const upstreamPort = await listen(
      net.createServer((socket) => socket.on("data", (chunk) => socket.end(`echo:${chunk}`))),
    );
    const tunnelPort = await listen(
      createTunnelServer({ targetHost: "127.0.0.1", targetPort: upstreamPort }, quietLog),
    );

    await expect(roundTrip(tunnelPort, "hello")).resolves.toBe("echo:hello");
  });

  it("closes the client when the model host is unreachable", async () => {
    const closed = net.createServer();
    const deadPort = await listen(closed);
    servers.splice(servers.indexOf(closed), 1);
    await close(closed);
    const tunnelPort = await listen(
      createTunnelServer({ targetHost: "127.0.0.1", targetPort: deadPort }, quietLog),
    );

    await expect(roundTrip(tunnelPort, "hello")).resolves.toBe("");
  });
});
