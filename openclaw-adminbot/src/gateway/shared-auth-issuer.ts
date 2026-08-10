// Resolves the issuer stamp the Gateway binds browser device tokens to.
//
// Device tokens minted for a browser must carry this stamp: connect rejects an issuer-less token
// from a browser-family device as a legacy credential, and rejects a stale generation after the
// shared secret rotates. Tokens issued outside the Gateway process (a plugin service that pairs a
// device from its own session) therefore need the same value the Gateway would have stamped.
import { getRuntimeConfig } from "../config/io/io.js";
import { resolveGatewayAuth } from "./auth/auth-resolve.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

/** Issuer stamp binding a device token to the Gateway's current shared-auth generation. */
export type SharedGatewayAuthIssuer = {
  kind: "shared-gateway-auth";
  generation: string;
};

/**
 * Issuer stamp for the Gateway's current shared auth, or undefined when no shared secret is
 * configured (the Gateway stamps nothing in that case either).
 */
export function resolveSharedGatewayAuthIssuer(): SharedGatewayAuthIssuer | undefined {
  // pin:false because the Gateway rolls the generation whenever the shared secret changes; a
  // pinned process snapshot would keep stamping tokens the Gateway then rejects as stale.
  const config = getRuntimeConfig({ pin: false });
  const auth = resolveGatewayAuth({
    authConfig: config.gateway?.auth,
    env: process.env,
  });
  const generation = resolveSharedGatewaySessionGeneration(auth, config.gateway?.trustedProxies);
  return generation ? { kind: "shared-gateway-auth", generation } : undefined;
}
