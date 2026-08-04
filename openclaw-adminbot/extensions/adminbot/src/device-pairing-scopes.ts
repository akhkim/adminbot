// Maps a lab member's privilege level to the gateway operator scopes their paired device may hold.
//
// This is the linchpin of member-side gateway enforcement: with device auth ON, the gateway binds
// a connection to the scopes approved for its paired device and clears self-declared scopes. So the
// only place "plain member vs admin" is decided is here, at device-approval time. Plain members get
// read only, which means `tools.invoke` (requires operator.write) is denied for them at the gateway
// — closing the escalation where a member self-granted operator.write over the shared token.

import type { AdminBotPrivilegeLevel } from "./contracts.js";

export const OPERATOR_READ_SCOPE = "operator.read" as const;

// The full Control-UI operator scope set an admin device is allowed. Must stay in sync with
// CONTROL_UI_OPERATOR_SCOPES in ui/src/ui/gateway.ts (the browser requests exactly these), because
// approveDevicePairing grants the browser's requested scopes bounded by this ceiling and *rejects*
// (never silently narrows) any request that exceeds it — a mismatch would 403 the admin's pairing.
export const PRIVILEGED_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

// Privileged members (the same set the service treats as admin, see requireMemberPrivileged) keep
// the full operator scope set they have today; everyone else is read-only. Read-only is the whole
// enforcement: `tools.invoke` requires operator.write, so a plain member's paired device cannot
// drive any privileged tool over the gateway — closing the escalation where a member self-granted
// operator.write/admin over the shared token. The Control-UI mirrors this in
// resolveMemberOperatorScopes (ui/src/ui/gateway.ts).
export function allowedGatewayScopesForPrivilege(
  privilege: AdminBotPrivilegeLevel,
): readonly string[] {
  const privileged = privilege === "admin" || privilege === "core_member";
  return privileged ? [...PRIVILEGED_OPERATOR_SCOPES] : [OPERATOR_READ_SCOPE];
}
