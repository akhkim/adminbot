#!/usr/bin/env node
// Forwards 127.0.0.1:8000 on this dev box to the vLLM server on the Aurora host over Tailscale.
//
// The reimbursement workflow deliberately refuses any non-loopback ADMINBOT_LOCAL_BASE_URL, so the
// dev box needs a real loopback listener even though the model itself runs on Aurora. Aurora is
// reached over the tailnet (already end-to-end encrypted), which is why this is a plain TCP relay
// and not an SSH tunnel: the box has no passwordless SSH key for the Aurora account.
import net from "node:net";

const listenHost = process.env.ADMINBOT_TUNNEL_LISTEN_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.ADMINBOT_TUNNEL_LISTEN_PORT ?? 8000);
// The tailnet address of the vLLM host. Deliberately has no default: it identifies one specific
// machine, and a baked-in address would silently relay private traffic to whatever now answers it.
// ADMINBOT_TUNNEL_TARGET_HOST is the old name for the same setting and is still accepted.
const targetHost = (
  process.env.ADMINBOT_TUNNEL_TARGET ??
  process.env.ADMINBOT_TUNNEL_TARGET_HOST ??
  ""
).trim();
if (!targetHost) {
  console.error(
    "ADMINBOT_TUNNEL_TARGET is not set — the tunnel has no vLLM host to forward to. Set it to the tailnet address of the model server.",
  );
  process.exit(1);
}
const targetPort = Number(process.env.ADMINBOT_TUNNEL_TARGET_PORT ?? 8000);

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost);
  // Either half closing tears down the pair; without this a failed connect leaks the client socket.
  const destroy = (error) => {
    if (error) {
      console.error(`tunnel error: ${error.message}`);
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

server.on("error", (error) => {
  console.error(`tunnel listen failed: ${error.message}`);
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  console.log(
    `AdminBot model tunnel: http://${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`,
  );
});
