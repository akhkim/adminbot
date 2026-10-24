// Member devices may read and chat, while privileged tools still require operator.write.

import type { AdminBotPrivilegeLevel } from "../../contracts/actions.js";

export const OPERATOR_READ_SCOPE = "operator.read" as const;

// The full Control-UI operator scope set an admin device is allowed. Must stay in sync with
// CONTROL_UI_OPERATOR_SCOPES in ui/src/ui/gateway.ts (the browser requests exactly these), because
// approveDevicePairing grants the browser's requested scopes bounded by this ceiling and *rejects*
// (never silently narrows) any request that exceeds it — a mismatch would 403 the admin's pairing.
export const PRIVILEGED_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.chat",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

// Must mirror resolveMemberOperatorScopes in the Control UI.
export function allowedGatewayScopesForPrivilege(
  privilege: AdminBotPrivilegeLevel,
): readonly string[] {
  const privileged = privilege === "admin";
  return privileged ? [...PRIVILEGED_OPERATOR_SCOPES] : [OPERATOR_READ_SCOPE, "operator.chat"];
}
