import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AdminBotMemoryStore } from "./persistence/memory.js";
import type {
  AdminBotCvChangeEvent,
  AdminBotCvEntry,
  AdminBotCvSnapshot,
  AdminBotLabMember,
} from "./contracts/actions.js";
import {
  assertPublicHost,
  classifyRecency,
  isPublicIpAddress,
  normalizeCvDownloadUrl,
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

// Starts one month before SCANNED_AT, so it is inside the recency window.
const POSITION: AdminBotCvEntry = {
  kind: "position",
  title: "Research Scientist",
  organization: "DeepMind",
  start: "Jul 2026",
  start_iso: "2026-07",
};

// The same shape of entry, but from years ago — someone backfilling their CV rather than moving.
const OLD_POSITION: AdminBotCvEntry = {
  kind: "position",
  title: "Summer Intern",
  organization: "Initech",
  start: "Jun 2019",
  start_iso: "2019-06",
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
    expect(result.results[0]).toMatchObject({
      status: "changed",
      added: [{ entry: POSITION, recency: "recent" }],
    });
    expect(result.newsletter_draft).toContain(
      "Jane Doe — joined DeepMind as Research Scientist (Jul 2026)",
    );
  });

  it("reports a backfilled entry as changed but keeps it out of the newsletter", async () => {
    // The whole point of the recency check: adding a 2019 internship changed the document, not
    // the person's career, and announcing it would read as nonsense.
    const { result } = await runAdminBotCvScan(
      [
        member({
          id: "backfill",
          name: "Jane Doe",
          cv_url: "https://drive.google.com/file/d/abc",
          cv_snapshot: snapshotOf("older cv", []),
        }),
      ],
      deps({ extractEntries: async () => [OLD_POSITION] }),
    );
    expect(result.results[0]).toMatchObject({
      status: "changed",
      added: [{ entry: OLD_POSITION, recency: "backfilled" }],
    });
    expect(result.newsletter_draft).toBe("");
  });

  it("reports an undated entry rather than guessing it is news", async () => {
    const undated: AdminBotCvEntry = { kind: "position", title: "Advisor", organization: "Acme" };
    const { result } = await runAdminBotCvScan(
      [
        member({
          id: "undated",
          cv_url: "https://drive.google.com/file/d/abc",
          cv_snapshot: snapshotOf("older cv", []),
        }),
      ],
      deps({ extractEntries: async () => [undated] }),
    );
    expect(result.results[0]?.added[0]?.recency).toBe("undated");
    expect(result.newsletter_draft).toBe("");
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

describe("classifyRecency", () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  const at = (start_iso?: string): AdminBotCvEntry => ({
    kind: "position",
    title: "T",
    organization: "O",
    ...(start_iso ? { start_iso } : {}),
  });

  it.each([
    ["2026-08", "recent", "this month"],
    ["2026-07", "recent", "last month"],
    ["2026-02", "recent", "exactly the window edge"],
    ["2026-10", "recent", "future — announced before it starts"],
  ])("%s is %s (%s)", (iso, expected) => {
    expect(classifyRecency(at(iso), now)).toBe(expected);
  });

  it.each([
    ["2026-01", "one month past the window"],
    ["2019-06", "years ago"],
  ])("%s is backfilled (%s)", (iso) => {
    expect(classifyRecency(at(iso), now)).toBe("backfilled");
  });

  it.each([
    [undefined, "no date at all"],
    ["", "empty"],
    ["2026", "year only — not placeable to a month"],
    ["Sept 2026", "the verbatim form leaked into start_iso"],
    ["2026-13", "impossible month"],
  ])("%s is undated (%s)", (iso) => {
    expect(classifyRecency(at(iso as string | undefined), now)).toBe("undated");
  });

  it("compares whole months so the day of the scan does not matter", () => {
    const first = new Date("2026-08-01T00:00:00.000Z");
    const last = new Date("2026-08-28T00:00:00.000Z");
    expect(classifyRecency(at("2026-02"), first)).toBe(classifyRecency(at("2026-02"), last));
  });
});

describe("CV change ledger", () => {
  const event = (overrides: Partial<AdminBotCvChangeEvent> = {}): AdminBotCvChangeEvent => ({
    member_id: "m1",
    member_name: "Jane Doe",
    detected_at: "2026-08-05T00:00:00.000Z",
    recency: "recent",
    entry: POSITION,
    ...overrides,
  });

  it("records a change once and ignores it on re-scan", () => {
    const store = new AdminBotMemoryStore();
    expect(store.recordCvChanges([event()])).toHaveLength(1);
    // A later scan re-reporting the same entry must not re-date it, or an old move would keep
    // resurfacing in every digest.
    expect(
      store.recordCvChanges([event({ detected_at: "2026-09-01T00:00:00.000Z" })]),
    ).toHaveLength(0);
    expect(store.listCvChangesSince("2026-01-01T00:00:00.000Z")).toHaveLength(1);
  });

  it("keeps the same entry apart for different members", () => {
    const store = new AdminBotMemoryStore();
    store.recordCvChanges([event(), event({ member_id: "m2", member_name: "Ada" })]);
    expect(store.listCvChangesSince("2026-01-01T00:00:00.000Z")).toHaveLength(2);
  });

  it("returns only what falls inside the window, oldest first", () => {
    const store = new AdminBotMemoryStore();
    store.recordCvChanges([
      event({ detected_at: "2026-06-01T00:00:00.000Z" }),
      event({ member_id: "m2", detected_at: "2026-08-01T00:00:00.000Z" }),
      event({ member_id: "m3", detected_at: "2026-07-01T00:00:00.000Z" }),
    ]);
    const since = store.listCvChangesSince("2026-07-01T00:00:00.000Z");
    expect(since.map((row) => row.member_id)).toEqual(["m3", "m2"]);
  });
});

describe("normalizeCvDownloadUrl", () => {
  const at = (raw: string) => normalizeCvDownloadUrl(new URL(raw)).toString();

  it("rewrites the Drive viewer link members actually paste", () => {
    // This exact shape returns ~80KB of HTML, which reaches PDFium as a "Data format error".
    expect(at("https://drive.google.com/file/d/1EkV76vhT3J6Z0VDB9cYBpeotbxWIJhOf/view?usp=sharing"))
      .toBe("https://drive.google.com/uc?export=download&id=1EkV76vhT3J6Z0VDB9cYBpeotbxWIJhOf");
  });

  it("handles the older open?id= form", () => {
    expect(at("https://drive.google.com/open?id=1EkV76vhT3J6Z0VDB9cYBpeotbxWIJhOf")).toContain(
      "uc?export=download&id=1EkV76vhT3J6Z0VDB9cYBpeotbxWIJhOf",
    );
  });

  it("exports a native Google Doc rather than downloading it", () => {
    // A Doc has no PDF bytes to fetch; Google has to render one.
    expect(at("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit#heading=x")).toBe(
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/export?format=pdf",
    );
  });

  it("exports Slides too", () => {
    expect(at("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit")).toBe(
      "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/export?format=pdf",
    );
  });

  it("leaves a direct PDF on another host alone", () => {
    expect(at("https://han.sparkenv.com/assets/pdf/portfolio.pdf")).toBe(
      "https://han.sparkenv.com/assets/pdf/portfolio.pdf",
    );
  });

  it("leaves a Google URL with no recognisable id alone", () => {
    expect(at("https://drive.google.com/drive/my-drive")).toBe(
      "https://drive.google.com/drive/my-drive",
    );
  });
});
