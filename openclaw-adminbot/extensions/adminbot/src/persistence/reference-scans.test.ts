import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ensureReferenceScanSchema,
  getReferenceScan,
  saveReferenceScan,
} from "./reference-scans.js";

describe("reference scan schema", () => {
  it("uses exactly four columns and independently stores each paper version", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureReferenceScanSchema(db);
      ensureReferenceScanSchema(db);
      expect(
        db
          .prepare("PRAGMA table_info(adminbot_reference_scans)")
          .all()
          .map((column) => [column.name, column.pk]),
      ).toEqual([
        ["submission_id", 1],
        ["pdf_sha256", 2],
        ["status", 0],
        ["result_json", 0],
      ]);
      for (const [paper, hash] of [
        ["paper123", "hash1"],
        ["paper123", "hash2"],
        ["paper456", "hash1"],
      ]) {
        saveReferenceScan(db, { submission_id: paper, pdf_sha256: hash, status: "running" });
      }
      saveReferenceScan(db, { submission_id: "paper123", pdf_sha256: "hash1", status: "failed" });
      expect(getReferenceScan(db, "paper123", "hash1")?.status).toBe("failed");
      expect(getReferenceScan(db, "paper123", "hash2")?.status).toBe("running");
      expect(getReferenceScan(db, "paper456", "hash1")?.status).toBe("running");
      expect(getReferenceScan(db, "absent", "hash1")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("migrates the initial MVP without losing results and can reopen the new schema", () => {
    const db = new DatabaseSync(":memory:");
    const result = {
      provider_scan_id: "synthetic",
      response_version: 1,
      citation_count: 0,
      uncertain_count: 0,
      findings: [],
    };
    try {
      db.exec(
        "CREATE TABLE adminbot_reference_scans (id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, pdf_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO adminbot_reference_scans VALUES (?, ?, ?, ?)").run(
        "old-id",
        "paper123",
        "hash1",
        JSON.stringify({
          status: "completed",
          result,
          title: "Synthetic",
          updated_at: "2026-01-01",
          notification_proposal_id: "proposal123",
        }),
      );
      ensureReferenceScanSchema(db);
      ensureReferenceScanSchema(db);
      expect(getReferenceScan(db, "paper123", "hash1")).toEqual({
        submission_id: "paper123",
        pdf_sha256: "hash1",
        status: "completed",
        result,
      });
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='adminbot_reference_scans_legacy'")
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rolls back the migration if an old record is invalid", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE adminbot_reference_scans (id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, pdf_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO adminbot_reference_scans VALUES (?, ?, ?, ?)").run(
        "old-id",
        "paper123",
        "hash1",
        "invalid-json",
      );
      expect(() => ensureReferenceScanSchema(db)).toThrow();
      expect(
        db.prepare("SELECT payload_json FROM adminbot_reference_scans").get()?.payload_json,
      ).toBe("invalid-json");
    } finally {
      db.close();
    }
  });
});
