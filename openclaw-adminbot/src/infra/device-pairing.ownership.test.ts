// Covers ownerMemberId plumbing through device pairing/token issuance, the seam AdminBot uses to
// scope a member's Control UI browser session to their own chat history.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  approveDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  requestDevicePairing,
  verifyDeviceToken,
} from "./device-pairing.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-device-pairing-owner-" });

async function makeDevicePairingDir(): Promise<string> {
  return await suiteRootTracker.make("case");
}

describe("device pairing ownerMemberId", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  test("carries ownerMemberId from a pairing request through to the approved device", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-owned",
        publicKey: "public-key-owned",
        role: "operator",
        scopes: ["operator.read"],
        ownerMemberId: "mem-1",
      },
      baseDir,
    );
    await approveDevicePairing(
      request.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );

    const paired = await getPairedDevice("device-owned", baseDir);
    expect(paired?.ownerMemberId).toBe("mem-1");
  });

  test("verifyDeviceToken surfaces the owning member's id", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-owned-2",
        publicKey: "public-key-owned-2",
        role: "operator",
        scopes: ["operator.read"],
        ownerMemberId: "mem-2",
      },
      baseDir,
    );
    await approveDevicePairing(
      request.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );
    const paired = await getPairedDevice("device-owned-2", baseDir);
    const token = paired?.tokens?.operator?.token;
    expect(typeof token).toBe("string");

    const verified = await verifyDeviceToken({
      deviceId: "device-owned-2",
      token: token as string,
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });

    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.ownerMemberId).toBe("mem-2");
  });

  test("leaves ownerMemberId unset for a device paired without one", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-unowned",
        publicKey: "public-key-unowned",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );
    await approveDevicePairing(
      request.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );

    const paired = await getPairedDevice("device-unowned", baseDir);
    expect(paired?.ownerMemberId).toBeUndefined();
  });

  test("ensureDeviceToken backfills ownerMemberId on an already-paired device", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-backfill",
        publicKey: "public-key-backfill",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );
    await approveDevicePairing(
      request.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );
    expect((await getPairedDevice("device-backfill", baseDir))?.ownerMemberId).toBeUndefined();

    await ensureDeviceToken({
      deviceId: "device-backfill",
      role: "operator",
      scopes: ["operator.read"],
      ownerMemberId: "mem-backfilled",
      baseDir,
    });

    expect((await getPairedDevice("device-backfill", baseDir))?.ownerMemberId).toBe(
      "mem-backfilled",
    );
  });

  test("ensureDeviceToken re-stamps a device's owner when a different member signs in on it", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-shared-browser",
        publicKey: "public-key-shared-browser",
        role: "operator",
        scopes: ["operator.read"],
        ownerMemberId: "mem-first",
      },
      baseDir,
    );
    await approveDevicePairing(
      request.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );
    expect((await getPairedDevice("device-shared-browser", baseDir))?.ownerMemberId).toBe(
      "mem-first",
    );

    await ensureDeviceToken({
      deviceId: "device-shared-browser",
      role: "operator",
      scopes: ["operator.read"],
      ownerMemberId: "mem-second",
      baseDir,
    });

    expect((await getPairedDevice("device-shared-browser", baseDir))?.ownerMemberId).toBe(
      "mem-second",
    );
  });
});
