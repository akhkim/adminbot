// Shared bootstrap/pairing helpers for plugins that provision remote devices.

export {
  approveDevicePairing,
  ensureDeviceToken,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
export {
  resolveSharedGatewayAuthIssuer,
  type SharedGatewayAuthIssuer,
} from "../gateway/shared-auth-issuer.js";
export {
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
export {
  normalizeDeviceBootstrapProfile,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
} from "../shared/device-bootstrap-profile.js";
