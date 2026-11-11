// "Mark reviewed" on My Desk, end to end through the service: the row goes to History, Undo
// brings it back, and a key the desk no longer shows is refused.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenReviewEvidence } from "../workflows/papers/openreview-paper-sync.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const NOW = "2026-10-24T08:55:00.000Z";

// The service stamps slot writes (`provided_at`) with the wall clock, and the sync only closes an
// ARR feedback request filed before that cycle's cutoff (2026-11-02 for ARR October 2026). Left on
// the real clock, the closing case passed until the cutoff and failed every day after it. Only
// Date is faked: the service's own timers have nothing to do with it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

function lab(store = new AdminBotMemoryStore()) {
  const service = new AdminBotService(store);
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
    } as never),
  );
  unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Causal Garden Planning",
      authors: ["Ada Lovelace"],
      current_step: "submission",
      first_author_member_id: "ada",
      venue: "ARR October 2026",
    }),
  );
  return service;
}

const submitted: OpenReviewEvidence = {
  source: "author_results",
  status: "under_review",
  title: "Causal Garden Planning",
  submission_id: "Abc123xyz",
  forums: ["Abc123xyz"],
  venue_id: "aclweb.org/ACL/ARR/2026/October",
  observed_at: "2026-10-10T12:00:00+00:00",
  reference: "n1",
};

const accepted: OpenReviewEvidence = {
  ...submitted,
  source: "author_results",
  status: "accepted",
  venue_id: "EMNLP/2026/Conference",
  track: "findings",
  presentation: "poster",
  observed_at: "2026-10-24T07:35:00+00:00",
  reference: "Abc123xyz",
};

const ackable = (service: AdminBotService) =>
  unwrap(service.listPiReviewQueue()).papers.filter((row) => row.ack_key);

describe("marking a My Desk row reviewed", () => {
  it("moves the row to History and Undo brings it back", () => {
    const service = lab();
    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    const [row] = ackable(service);
    expect(row?.ack_key).toBeTruthy();
    const key = row!.ack_key!;

    expect(unwrap(service.setPiReviewAck("zhijing", { key, reviewed: true }))).toEqual({
      key,
      reviewed: true,
    });
    const after = unwrap(service.listPiReviewQueue());
    expect(after.papers.some((open) => open.ack_key === key)).toBe(false);
    expect(after.history.find((old) => old.ack_key === key)?.history_reason).toBe("reviewed");

    unwrap(service.setPiReviewAck("zhijing", { key, reviewed: false }));
    expect(ackable(service).some((open) => open.ack_key === key)).toBe(true);
  });

  it("refuses a key the desk no longer shows", () => {
    const service = lab();
    const result = service.setPiReviewAck("zhijing", { key: "p1|gone||", reviewed: true });
    expect(result.ok).toBe(false);
    expect(result.ok ? 0 : result.status).toBe(404);
    expect(service.setPiReviewAck("zhijing", { key: "", reviewed: true }).ok).toBe(false);
  });
});
