import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AdminBotCvEntry,
  AdminBotCvSnapshot,
  AdminBotLabMember,
} from "./contracts/actions.js";
import {
  assertPublicHost,
  isPublicIpAddress,
  runAdminBotCvScan,
  type AdminBotCvScanDeps,
} from "./cv-scan.js";

const SCANNED_AT = new Date("2026-08-05T12:00:00.000Z");

function member(overrides: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember {
  return {
    name: `Member ${overrides.id}`,
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshotOf(text: string, entries: AdminBotCvEntry[]): AdminBotCvSnapshot {
  return {
    fetched_at: "2026-01-01T00:00:00.000Z",
    content_hash: createHash("sha256").update(text).digest("hex"),
    entries,
  };
}

function deps(overrides: Partial<AdminBotCvScanDeps> = {}): AdminBotCvScanDeps {
  return {
    now: () => SCANNED_AT,
    fetchPdf: async () => new Uint8Array([1]),
    extractText: async () => ({ ok: true, text: "cv text" }),
    extractEntries: async () => [],
    ...overrides,
  };
}

const POSITION: AdminBotCvEntry = {
  kind: "position",
  title: "Research Scientist",
  organization: "DeepMind",
  start: "Sept 2026",
};

describe("runAdminBotCvScan", () => {
  it("ignores members with no CV link entirely", async () => {
    const { result } = await runAdminBotCvScan([member({ id: "no-cv" })], deps());
    expect(result.results).toEqual([]);
  });

  it("reports a first scan without drafting the person's whole history", async () => {
    const { result, snapshots } = await runAdminBotCvScan(
      [member({ id: "new", cv_url: "https://drive.google.com/file/d/abc" })],
      deps({ extractEntries: async () => [POSITION] }),
    );
    expect(result.results[0]).toMatchObject({ member_id: "new", status: "first_scan", added: [] });
    // The snapshot is still stored, so the *next* scan has a baseline to diff against.
    expect(snapshots.get("new")?.entries).toEqual([POSITION]);
    expect(result.newsletter_draft).toBe("");
  });

  it("skips the model call when the document hash is unchanged", async () => {
    const extractEntries = vi.fn(async () => [POSITION]);
    const { result, snapshots } = await runAdminBotCvScan(
      [
        member({
          id: "same",
          cv_url: "https://drive.google.com/file/d/abc",
          cv_snapshot: snapshotOf("cv text", [POSITION]),
        }),
      ],
      deps({ extractEntries }),
    );
    expect(result.results[0]?.status).toBe("unchanged");
    expect(extractEntries).not.toHaveBeenCalled();
    expect(snapshots.size).toBe(0);
  });

  it("drafts newsletter copy from newsworthy additions", async () => {
    const { result } = await runAdminBotCvScan(
      [
        member({
          id: "moved",
          name: "Jane Doe",
          cv_url: "https://drive.google.com/file/d/abc",
          cv_snapshot: snapshotOf("older cv", []),
        }),
      ],
      deps({ extractEntries: async () => [POSITION] }),
    );
    expect(result.results[0]).toMatchObject({ status: "changed", added: [POSITION] });
    expect(result.newsletter_draft).toContain(
      "Jane Doe — joined DeepMind as Research Scientist (Sept 2026)",
    );
  });

  it("reports removals but keeps them out of the draft", async () => {
    const { result } = await runAdminBotCvScan(
      [
        member({
          id: "trimmed",
          cv_url: "https://drive.google.com/file/d/abc",
          cv_snapshot: snapshotOf("older cv", [POSITION]),
        }),
      ],
      deps({ extractEntries: async () => [] }),
    );
    expect(result.results[0]).toMatchObject({ status: "changed", removed: [POSITION] });
    expect(result.newsletter_draft).toBe("");
  });

  it("treats a reformatted date as unchanged rather than a career move", async () => {
    const { result } = await runAdminBotCvScan(
      [
        member({
          id: "reformatted",
          cv_url: "https://drive.google.com/file/d/abc",
          cv_snapshot: snapshotOf("older cv", [POSITION]),
        }),
      ],
      deps({ extractEntries: async () => [{ ...POSITION, start: "09/2026" }] }),
    );
    expect(result.results[0]).toMatchObject({ status: "unchanged", added: [], removed: [] });
  });

  it("refuses a non-https link without fetching it", async () => {
    const fetchPdf = vi.fn(async () => new Uint8Array([1]));
    const { result } = await runAdminBotCvScan(
      [member({ id: "insecure", cv_url: "http://example.com/cv.pdf" })],
      deps({ fetchPdf }),
    );
    expect(result.results[0]).toMatchObject({ status: "skipped", reason: "cv url must use https" });
    expect(fetchPdf).not.toHaveBeenCalled();
  });

  it("keeps scanning the roster after one member fails", async () => {
    const { result } = await runAdminBotCvScan(
      [
        member({ id: "broken", cv_url: "https://drive.google.com/file/d/broken" }),
        member({
          id: "fine",
          name: "Ada",
          cv_url: "https://drive.google.com/file/d/fine",
          cv_snapshot: snapshotOf("older cv", []),
        }),
      ],
      deps({
        fetchPdf: async (url) => {
          if (url.endsWith("broken")) {
            throw new Error("404 from Drive");
          }
          return new Uint8Array([1]);
        },
        extractEntries: async () => [POSITION],
      }),
    );
    expect(result.results[0]).toMatchObject({ status: "failed", reason: "404 from Drive" });
    expect(result.results[1]?.status).toBe("changed");
    expect(result.newsletter_draft).toContain("Ada");
  });

  it("separates an unreadable scan from one with no changes", async () => {
    const { result } = await runAdminBotCvScan(
      [member({ id: "scanned-paper", cv_url: "https://drive.google.com/file/d/abc" })],
      deps({ extractText: async () => ({ ok: false, reason: "no_text_layer" }) }),
    );
    expect(result.results[0]).toMatchObject({ status: "failed", reason: "no_text_layer" });
  });
});

describe("isPublicIpAddress", () => {
  // Each of these is a real place a forged request would try to reach from the service host.
  it.each([
    ["127.0.0.1", "loopback — the AdminBot API itself"],
    ["169.254.169.254", "cloud instance metadata"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private, top of range"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "this-network"],
    ["224.0.0.1", "multicast"],
    ["::1", "IPv6 loopback"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link local"],
    ["::ffff:127.0.0.1", "IPv4 loopback mapped into IPv6"],
    ["::ffff:169.254.169.254", "metadata address mapped into IPv6"],
    ["not-an-ip", "unparseable"],
  ])("refuses %s (%s)", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["172.32.0.1"], ["192.169.0.1"], ["2606:4700::1111"]])(
    "allows public %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );
});

describe("assertPublicHost", () => {
  it("accepts a host that resolves entirely to public addresses", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8" }]);
    await expect(
      assertPublicHost("example.com", lookup as never),
    ).resolves.toBeUndefined();
  });

  it("refuses a host whose addresses include a private one", async () => {
    // A name answering with one public and one private address would otherwise be usable to reach
    // the private one, so every record has to pass.
    const lookup = vi.fn(async () => [{ address: "8.8.8.8" }, { address: "10.1.2.3" }]);
    await expect(assertPublicHost("rebind.example", lookup as never)).rejects.toThrow(
      /non-public address \(10\.1\.2\.3\)/u,
    );
  });

  it("checks an IP literal directly without consulting DNS", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8" }]);
    await expect(assertPublicHost("169.254.169.254", lookup as never)).rejects.toThrow(
      /non-public address/u,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to nothing", async () => {
    const lookup = vi.fn(async () => []);
    await expect(assertPublicHost("void.example", lookup as never)).rejects.toThrow(
      /resolved to no addresses/u,
    );
  });
});
