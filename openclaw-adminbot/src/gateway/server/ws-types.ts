// Gateway WebSocket client types describe authenticated client state retained by the server.
import type { WebSocket } from "ws";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/index.js";
import type { PluginNodeCapabilityClient } from "../plugin-node-capability.js";

/**
 * Runtime WebSocket client state tracked by the gateway server.
 */
export type GatewayWsClient = PluginNodeCapabilityClient & {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  isDeviceTokenAuth?: boolean;
  // The identity (e.g. AdminBot member id) this connection's paired device is owned by, resolved
  // from the device-pairing store at connect time. Undefined for connections with no paired
  // device (shared-secret fallback, CLI/single-operator use) -- those keep today's unscoped
  // behavior, see canRequesterAccessSession in server-methods/session-ownership.ts.
  ownerMemberId?: string;
  usesSharedGatewayAuth: boolean;
  sharedGatewaySessionGeneration?: string;
  presenceKey?: string;
  clientIp?: string;
  internal?: {
    approvalRuntime?: boolean;
  };
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
  invalidated?: boolean;
  invalidatedReason?: string;
};
