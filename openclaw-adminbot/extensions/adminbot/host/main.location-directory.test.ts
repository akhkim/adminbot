/**
 * Tests the IP-geolocation and Slack directory/timezone resolvers built by the AdminBot
 * composition root: private/loopback IP filtering, ipapi.co response handling, and the two
 * Slack-CLI-backed lookups (per-user timezone, email-to-user-id directory resolution).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import {
  createIpLocationResolver,
  createSlackDirectoryEmailResolver,
  createSlackTimezoneReader,
  isNonRoutableIp,
} from "./main.js";

function mockExecFileSuccess(stdout: string) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (error: unknown, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout, stderr: "" });
    },
  );
}

function mockExecFileFailure(error: Error) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (error: unknown, result?: unknown) => void,
    ) => {
      callback(error);
    },
  );
}

describe("isNonRoutableIp", () => {
  it("flags loopback, private, link-local, and Tailscale CGNAT ranges", () => {
    expect(isNonRoutableIp("127.0.0.1")).toBe(true);
    expect(isNonRoutableIp("10.1.2.3")).toBe(true);
    expect(isNonRoutableIp("192.168.1.1")).toBe(true);
    expect(isNonRoutableIp("172.16.0.1")).toBe(true);
    expect(isNonRoutableIp("172.31.255.255")).toBe(true);
    expect(isNonRoutableIp("169.254.1.1")).toBe(true);
    expect(isNonRoutableIp("100.100.1.1")).toBe(true);
    expect(isNonRoutableIp("::1")).toBe(true);
    expect(isNonRoutableIp("fe80::1")).toBe(true);
  });

  it("does not flag public IPs, including addresses that merely start with private-looking octets", () => {
    expect(isNonRoutableIp("203.0.113.5")).toBe(false);
    expect(isNonRoutableIp("8.8.8.8")).toBe(false);
    // 172.32.x is outside the 172.16-31 private block.
    expect(isNonRoutableIp("172.32.0.1")).toBe(false);
    // 100.128.x is outside the 100.64-127 Tailscale CGNAT block.
    expect(isNonRoutableIp("100.128.0.1")).toBe(false);
  });
});

describe("createIpLocationResolver", () => {
  const geolocateIp = createIpLocationResolver();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls out for a private/loopback IP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await geolocateIp("10.0.0.5");

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("joins city/region/country from a successful lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ city: "Toronto", region: "Ontario", country_name: "Canada" }),
          { status: 200 },
        ),
      ),
    );

    expect(await geolocateIp("203.0.113.5")).toBe("Toronto, Ontario, Canada");
  });

  it("returns undefined when the provider reports its own error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: true }), { status: 200 })),
    );

    expect(await geolocateIp("203.0.113.5")).toBeUndefined();
  });

  it("returns undefined on a non-ok HTTP response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    expect(await geolocateIp("203.0.113.5")).toBeUndefined();
  });

  it("returns undefined when the network call itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    expect(await geolocateIp("203.0.113.5")).toBeUndefined();
  });
});

describe("createSlackTimezoneReader", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("extracts the IANA tz for each resolvable user and skips failures", async () => {
    execFileMock
      .mockImplementationOnce(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (error: unknown, result: { stdout: string; stderr: string }) => void,
        ) => callback(null, { stdout: JSON.stringify({ user: { tz: "America/Toronto" } }), stderr: "" }),
      )
      .mockImplementationOnce(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (error: unknown) => void,
        ) => callback(new Error("lookup failed")),
      );

    const fetchSlackTimezones = createSlackTimezoneReader("/repo");
    const result = await fetchSlackTimezones(["U1", "U2"]);

    expect(result.get("U1")).toBe("America/Toronto");
    expect(result.has("U2")).toBe(false);
  });

  it("ignores a location-only profile field and never substitutes it for tz", async () => {
    mockExecFileSuccess(
      JSON.stringify({
        user: { profile: { fields: { f1: { value: "Toronto Office" } } } },
      }),
    );

    const result = await createSlackTimezoneReader("/repo")(["U1"]);

    expect(result.has("U1")).toBe(false);
  });
});

describe("createSlackDirectoryEmailResolver", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("resolves only the requested emails and strips the channel-native id prefix", async () => {
    mockExecFileSuccess(
      JSON.stringify([
        { id: "user:U1", raw: { profile: { email: "wanted@cs.toronto.edu" } } },
        { id: "user:U2", raw: { profile: { email: "unwanted@cs.toronto.edu" } } },
      ]),
    );

    const resolveSlackUserIdsByEmail = createSlackDirectoryEmailResolver("/repo");
    const result = await resolveSlackUserIdsByEmail(["Wanted@CS.Toronto.edu"]);

    expect(result.get("wanted@cs.toronto.edu")).toBe("U1");
    expect(result.has("unwanted@cs.toronto.edu")).toBe(false);
  });

  it("returns an empty map without shelling out when no emails are requested", async () => {
    const result = await createSlackDirectoryEmailResolver("/repo")([]);

    expect(result.size).toBe(0);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns an empty map rather than throwing when the CLI call fails", async () => {
    mockExecFileFailure(new Error("directory unreachable"));

    const result = await createSlackDirectoryEmailResolver("/repo")(["a@cs.toronto.edu"]);

    expect(result.size).toBe(0);
  });
});
