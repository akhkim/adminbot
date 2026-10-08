import { describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequest } from "../../contracts/actions.js";
import { logisticsListRow } from "./list-row.js";
import { requestDeadlineDetails } from "./requests.js";

const LETTERS: AdminBotLogisticsRequest = {
  id: "req-1",
  kind: "recommendation_letters",
  member_id: "ada",
  member_name: "Ada",
  status: "in_progress",
  submitted_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-02T00:00:00.000Z",
  deadline_at: "2026-12-01T11:59:00.000Z",
  schools: [
    {
      school: "MIT",
      program: "PhD CS",
      program_link: "https://mit.example/phd",
      application_deadline: "2026-11-15",
      letter_deadline: "2026-12-01",
      letter_deadline_time: "23:59",
      deadline_timezone: "AoE",
      letter_status: "pending",
      notes: "Ask about the robotics group.",
    },
  ],
  facts: [{ project: "Paper A", contribution: "Ran every experiment." }],
  cv_overleaf_url: "https://overleaf.example/cv",
  drive_folder_url: "https://drive.example/folder",
  resolution_note: "On it.",
  decided_by: "prof",
  decided_at: "2026-09-02T00:00:00.000Z",
};

describe("logisticsListRow", () => {
  it("keeps the queue's columns and the school fields the deadline is read from", () => {
    expect(logisticsListRow(LETTERS)).toEqual({
      id: "req-1",
      kind: "recommendation_letters",
      member_id: "ada",
      member_name: "Ada",
      status: "in_progress",
      submitted_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z",
      deadline_at: "2026-12-01T11:59:00.000Z",
      schools: [
        {
          school: "MIT",
          letter_deadline: "2026-12-01",
          letter_deadline_time: "23:59",
          deadline_timezone: "AoE",
        },
      ],
    });
  });

  it("shows the same deadline the full record does", () => {
    const meeting: AdminBotLogisticsRequest = {
      id: "req-2",
      kind: "book_meeting",
      member_id: "ada",
      member_name: "Ada",
      status: "submitted",
      submitted_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      meetings: [
        {
          purpose: "Thesis plan",
          preferred_time: "2026-10-01T09:30",
          timezone: "Europe/Zurich",
          city: "Zurich",
          doc_prep_url: "https://docs.example/q",
          length_minutes: 30,
        },
      ],
    };
    for (const request of [LETTERS, meeting]) {
      expect(requestDeadlineDetails(logisticsListRow(request))).toEqual(
        requestDeadlineDetails(request),
      );
    }
    expect(logisticsListRow(meeting).meetings).toEqual([
      { purpose: "Thesis plan", preferred_time: "2026-10-01T09:30", timezone: "Europe/Zurich" },
    ]);
  });

  it("keeps the signed-and-sent stamp a settled signature row shows", () => {
    const row = logisticsListRow({
      id: "req-3",
      kind: "document_signature",
      member_id: "ada",
      member_name: "Ada",
      status: "completed",
      submitted_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z",
      description: "Visa letter",
      documents: [{ name: "form.pdf", size: 10 }],
      signed_documents: [{ name: "form-signed.pdf", size: 12 }],
      signed_sent_at: "2026-09-03T00:00:00.000Z",
      signed_sent_to: "ada@example.edu",
      files_cleared_at: "2026-09-03T00:00:00.000Z",
    });
    expect(row).toMatchObject({
      signed_sent_at: "2026-09-03T00:00:00.000Z",
      signed_sent_to: "ada@example.edu",
    });
    for (const key of ["description", "documents", "signed_documents", "files_cleared_at"]) {
      expect(row).not.toHaveProperty(key);
    }
  });
});
