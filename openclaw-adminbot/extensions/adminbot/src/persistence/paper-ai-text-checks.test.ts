import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ensurePaperAiTextCheckSchema,
  getPaperAiTextCheck,
  savePaperAiTextCheck,
} from "./paper-ai-text-checks.js";

describe("paper AI-text check persistence", () => {
  // The live database was created before scoring moved to the whole PDF. Its rows have to survive
  // the new column, and read back as text-era scores so the watch re-scores them once.
  it("adds the scoring columns to an existing table, keeping its rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE adminbot_paper_ai_text_checks (
      submission_id TEXT NOT NULL, pdf_path TEXT NOT NULL, pdf_sha256 TEXT, title TEXT NOT NULL,
      venue_id TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL,
      attempts INTEGER NOT NULL, fraction_ai REAL, fraction_ai_assisted REAL, fraction_human REAL,
      prediction TEXT, words_scored INTEGER, error TEXT, alerted_for_json TEXT,
      alert_proposal_ids_json TEXT, alert_error TEXT, PRIMARY KEY (submission_id, pdf_path))`);
    db.exec(`INSERT INTO adminbot_paper_ai_text_checks (submission_id, pdf_path, title, venue_id,
      status, checked_at, attempts, fraction_ai) VALUES ('p1', '/pdf/v1.pdf', 'Synthetic', 'V',
      'completed', '2026-09-25T00:00:00.000Z', 1, 0.03)`);

    ensurePaperAiTextCheckSchema(db);
    ensurePaperAiTextCheckSchema(db);

    const old = getPaperAiTextCheck(db, "p1", "/pdf/v1.pdf");
    expect(old).toMatchObject({ status: "completed", fraction_ai: 0.03 });
    expect(old?.scored_from).toBeUndefined();

    expect(old?.model_version).toBeUndefined();

    savePaperAiTextCheck(db, {
      ...old!,
      scored_from: "full_text",
      model_version: "4.0",
      fraction_ai: 0.82,
    });
    expect(getPaperAiTextCheck(db, "p1", "/pdf/v1.pdf")).toMatchObject({
      scored_from: "full_text",
      model_version: "4.0",
      fraction_ai: 0.82,
    });
  });
});
