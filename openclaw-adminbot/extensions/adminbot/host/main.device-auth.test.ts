import { expect, it, vi } from "vitest";
import { createDeviceTokenIssuer, createDevicePairingApprover } from "./main.js";

function pairing() {
  return {
    resolveSharedGatewayAuthIssuer: vi.fn(() => ({
      kind: "shared-gateway-auth" as const,
      generation: "synthetic",
    })),
    ensureDeviceToken: vi
      .fn<(...args: unknown[]) => Promise<{ token: string; scopes: string[] } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ token: "synthetic-token", scopes: ["operator.read"] }),
    requestDevicePairing: vi
      .fn()
      .mockResolvedValue({ request: { requestId: "synthetic-request" } }),
    approveDevicePairing: vi.fn().mockResolvedValue({ status: "approved" }),
  };
}
const params = {
  deviceId: "synthetic-device",
  publicKey: "synthetic-key",
  memberId: "synthetic-member",
  allowedScopes: ["operator.read"],
};

it("pairs a browser with member-capped scopes and the configured gateway issuer", async () => {
  const devicePairing = pairing();
  expect(await createDeviceTokenIssuer({ devicePairing })(params)).toEqual({
    ok: true,
    token: "synthetic-token",
    scopes: ["operator.read"],
  });
  expect(devicePairing.approveDevicePairing).toHaveBeenCalledWith("synthetic-request", {
    callerScopes: ["operator.read"],
  });
  expect(devicePairing.ensureDeviceToken).toHaveBeenLastCalledWith(
    expect.objectContaining({
      ownerMemberId: "synthetic-member",
      scopes: ["operator.read"],
      issuer: { kind: "shared-gateway-auth", generation: "synthetic" },
    }),
  );
});

it("does not issue a token after pairing approval is refused", async () => {
  const devicePairing = pairing();
  devicePairing.approveDevicePairing.mockResolvedValue({ status: "forbidden" });
  expect(await createDeviceTokenIssuer({ devicePairing })(params)).toMatchObject({
    ok: false,
    reason: "failed",
  });
  expect(devicePairing.ensureDeviceToken).toHaveBeenCalledTimes(1);
});

it("fails closed when the gateway has no shared-auth issuer", async () => {
  const devicePairing = { ...pairing(), resolveSharedGatewayAuthIssuer: () => undefined };
  expect(await createDeviceTokenIssuer({ devicePairing })(params)).toMatchObject({
    ok: false,
    reason: "unsupported",
  });
  expect(devicePairing.requestDevicePairing).not.toHaveBeenCalled();
});

it("caps recovery approvals at the supplied member scopes", async () => {
  const devicePairing = pairing();
  await createDevicePairingApprover({ devicePairing })({
    requestId: "synthetic-request",
    allowedScopes: ["operator.read"],
  });
  expect(devicePairing.approveDevicePairing).toHaveBeenCalledWith("synthetic-request", {
    callerScopes: ["operator.read"],
  });
});
