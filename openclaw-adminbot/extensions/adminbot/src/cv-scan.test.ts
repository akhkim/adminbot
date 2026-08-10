import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AdminBotCvEntry, AdminBotCvSnapshot, AdminBotLabMember } from "./contracts.js";
import { runAdminBotCvScan, type AdminBotCvScanDeps } from "./cv-scan.js";

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

  it("refuses a stored link pointing off the allowlist", async () => {
    const fetchPdf = vi.fn(async () => new Uint8Array([1]));
    const { result } = await runAdminBotCvScan(
      [member({ id: "evil", cv_url: "https://internal.example/admin" })],
      deps({ fetchPdf }),
    );
    expect(result.results[0]?.status).toBe("skipped");
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
