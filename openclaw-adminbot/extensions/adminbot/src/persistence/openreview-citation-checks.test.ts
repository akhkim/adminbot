import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ensureOpenReviewCitationCheckSchema,
  getOpenReviewCitationCheck,
  saveOpenReviewCitationCheck,
} from "./openreview-citation-checks.js";

describe("OpenReview citation check persistence", () => {
  it("adds extractor_version to a first-release table, keeping its rows as version 1", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE adminbot_openreview_citation_checks (
      submission_id TEXT NOT NULL, pdf_path TEXT NOT NULL, pdf_sha256 TEXT, title TEXT NOT NULL,
      venue_id TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL,
      attempts INTEGER NOT NULL, findings_json TEXT, error TEXT, notification_proposal_id TEXT,
      PRIMARY KEY (submission_id, pdf_path))`);
    db.exec(`INSERT INTO adminbot_openreview_citation_checks VALUES
      ('paperAAAA', '/pdf/v1.pdf', NULL, 'Synthetic', 'Synth/Submission', 'unreadable',
       '2026-09-23T17:00:00.000Z', 1, NULL, 'could not split', NULL)`);
    ensureOpenReviewCitationCheckSchema(db);
    ensureOpenReviewCitationCheckSchema(db);
    const old = getOpenReviewCitationCheck(db, "paperAAAA", "/pdf/v1.pdf")!;
    expect(old.status).toBe("unreadable");
    expect(old.extractor_version).toBeUndefined();
    saveOpenReviewCitationCheck(db, { ...old, status: "completed", extractor_version: 2 });
    expect(getOpenReviewCitationCheck(db, "paperAAAA", "/pdf/v1.pdf")).toMatchObject({
      status: "completed",
      extractor_version: 2,
    });
  });
});
