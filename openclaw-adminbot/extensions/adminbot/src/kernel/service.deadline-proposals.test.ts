import { describe, expect, it } from "vitest";
import type { DeadlineProposalInput } from "../contracts/deadline-proposals.js";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { AdminBotService } from "./service.js";

function input(overrides: Partial<DeadlineProposalInput> = {}): DeadlineProposalInput {
  return {
    name: "Example Workshop",
    parentConference: "EMNLP",
    parentYear: "2026",
    entryType: "workshop",
    deadlineDate: "2026-09-14",
    deadlineTime: "23:59",
    timezone: "Etc/GMT+12",
    homepageUrl: "https://example.org/workshop",
    cfpUrl: "https://example.org/cfp",
    openReviewUrl: "https://openreview.net/group?id=example",
    note: "Verify the archival route.",
    ...overrides,
  };
}

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

describe("deadline proposals", () => {
  it("makes repeated member submissions idempotent and flags likely duplicates", () => {
    const service = new AdminBotService(new AdminBotMemoryStore());
    const existing = [
      {
        id: "existing-deadline",
        deadline_id: "existing-deadline",
        name: "Example Workshop",
        entry_type: "workshop",
        deadline_aoe: "2026-09-14 23:59:00",
        source_url: "https://example.org/cfp",
      },
    ];

    const first = unwrap(service.submitDeadlineProposal(input(), "member-1", "retry-1", existing));
    const replay = unwrap(service.submitDeadlineProposal(input(), "member-1", "retry-1", existing));

    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({
      status: "pending",
      submitter_member_id: "member-1",
      duplicate_deadline_ids: ["existing-deadline"],
    });
    const second = unwrap(
      service.submitDeadlineProposal(input({ name: "Another Workshop" }), "member-2", "retry-2"),
    );
    expect(unwrap(service.listDeadlineProposals()).proposals).toHaveLength(2);
    expect(unwrap(service.listDeadlineProposals("member-1")).proposals.map(({ id }) => id)).toEqual(
      [first.id],
    );
    expect(unwrap(service.listDeadlineProposals("member-2")).proposals.map(({ id }) => id)).toEqual(
      [second.id],
    );
  });

  it("creates an append-only revision with a new approval-bound payload", () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    const submitted = unwrap(service.submitDeadlineProposal(input(), "member-1", "retry-1"));

    const revised = unwrap(
      service.reviseDeadlineProposal(
        submitted.id,
        input({ deadlineDate: "2026-09-21", note: "Extended by one week." }),
        "admin-1",
      ),
    );

    expect(revised.current_revision).toBe(2);
    expect(revised.payload_hash).not.toBe(submitted.payload_hash);
    expect(revised.revisions).toMatchObject([
      { revision: 1, status: "rejected", deadline: { deadlineDate: "2026-09-14" } },
      { revision: 2, status: "pending", deadline: { deadlineDate: "2026-09-21" } },
    ]);
  });

  it("publishes only the exact approved revision into the public read model", async () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    const submitted = unwrap(service.submitDeadlineProposal(input(), "member-1", "retry-1"));

    const wrongHash = await service.publishDeadlineProposal(submitted.id, "wrong", {
      payload_hash: "wrong",
      approver_role: "admin",
      approver_id: "admin-1",
    });
    expect(wrongHash).toMatchObject({ ok: false, status: 409 });
    expect(service.deadlineReadModel([])).toEqual([]);

    const published = unwrap(
      await service.publishDeadlineProposal(submitted.id, submitted.payload_hash, {
        payload_hash: submitted.payload_hash,
        approver_role: "admin",
        approver_id: "admin-1",
      }),
    );
    expect(published.status).toBe("published");
    expect(service.deadlineReadModel([])).toMatchObject([
      {
        id: submitted.deadline_id,
        name: "Example Workshop",
        venue_group: "EMNLP 2026 Workshops",
        deadline_aoe: "2026-09-14 23:59:00",
        homepage_url: "https://example.org/workshop",
        cfp_url: "https://example.org/cfp",
        revisions: [{ observed_at: expect.any(String) }],
      },
    ]);
    expect(service.listAuditEvents().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "deadline_proposal.submitted",
        "approval.recorded",
        "deadline_proposal.published",
        "execution.executed",
      ]),
    );
  });

  it("publishes a correction as another public revision without rewriting history", async () => {
    const service = new AdminBotService(new AdminBotMemoryStore());
    const first = unwrap(service.submitDeadlineProposal(input(), "member-1", "retry-1"));
    unwrap(
      await service.publishDeadlineProposal(first.id, first.payload_hash, {
        payload_hash: first.payload_hash,
        approver_role: "admin",
        approver_id: "admin-1",
      }),
    );
    const revision = unwrap(
      service.reviseDeadlineProposal(first.id, input({ deadlineDate: "2026-09-21" }), "admin-1"),
    );
    unwrap(
      await service.publishDeadlineProposal(first.id, revision.payload_hash, {
        payload_hash: revision.payload_hash,
        approver_role: "admin",
        approver_id: "admin-1",
      }),
    );

    expect(service.deadlineReadModel([])).toMatchObject([
      {
        deadline_aoe: "2026-09-21 23:59:00",
        revisions: [
          { deadline_aoe: "2026-09-14 23:59:00" },
          { deadline_aoe: "2026-09-21 23:59:00" },
        ],
      },
    ]);
  });
});
