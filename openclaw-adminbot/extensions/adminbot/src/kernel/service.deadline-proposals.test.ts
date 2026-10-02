import { describe, expect, it } from "vitest";
import type { DeadlineProposalInput } from "../contracts/deadline-proposals.js";
import { stageSnapshot } from "../contracts/deadline-proposals.stage.js";
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

describe("deadline read model", () => {
  const compiled = [
    {
      id: "compiled-venue",
      deadline_id: "compiled-venue",
      name: "Compiled Conference",
      entry_type: "conference",
      deadline_aoe: "2026-09-25 23:59:00",
    },
  ];

  it("serves the compiled dataset when the runtime dataset cannot be read", () => {
    // `/deadlines` is public and the board ships no bundled copy of its own, so an
    // exception from the file-backed dataset used to empty the board for every visitor at once.
    const service = new AdminBotService(new AdminBotMemoryStore(), {
      deadlineDataset: () => {
        throw new Error("Deadline dataset is empty or invalid");
      },
    });
    expect(service.deadlineReadModel(compiled)).toEqual(compiled);
  });

  it("still constructs when the runtime dataset is unreadable and the roster is not empty", () => {
    // The constructor reconciles every member's milestones through this read model, so an
    // unreadable dataset file did not only blank the board -- it threw out of `new AdminBotService`
    // and the whole service failed to start.
    const store = new AdminBotMemoryStore();
    const seed = new AdminBotService(store);
    expect(
      seed.upsertLabMember({
        receives_nudges: true,
        id: "member-with-milestones",
        name: "Member With Milestones",
        privilege_level: "member",
        member_type: "full",
      }).ok,
    ).toBe(true);
    expect(
      () =>
        new AdminBotService(store, {
          deadlineDataset: () => {
            throw new Error("ENOENT: no such file or directory");
          },
        }),
    ).not.toThrow();
  });

  it("prefers the runtime dataset when it reads cleanly", () => {
    const fresh = [{ ...compiled[0], id: "fresh-venue", name: "Refreshed Conference" }];
    const service = new AdminBotService(new AdminBotMemoryStore(), {
      deadlineDataset: () => fresh,
    });
    expect(service.deadlineReadModel(compiled)).toEqual(fresh);
  });
});

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

it("validates visitor contact details and supports name-only or email-only submissions", () => {
  const service = new AdminBotService(new AdminBotMemoryStore());
  for (const invalid of [
    null,
    [],
    { name: 42 },
    { email: 42 },
    { name: "x".repeat(201) },
    { email: "not-an-email" },
  ]) {
    expect(
      service.submitDeadlineProposal(
        input(),
        "visitor:deadline:test",
        "invalid",
        [],
        invalid as never,
      ),
    ).toMatchObject({ ok: false, status: 400 });
  }
  expect(unwrap(service.listDeadlineProposals()).proposals).toHaveLength(0);
  expect(
    unwrap(
      service.submitDeadlineProposal(input(), "visitor:deadline:one", "one", [], {
        name: " Taylor ",
      }),
    ),
  ).toMatchObject({ submitter_name: "Taylor" });
  expect(
    unwrap(
      service.submitDeadlineProposal(input(), "visitor:deadline:two", "two", [], {
        email: " taylor@example.org ",
      }),
    ),
  ).toMatchObject({ submitter_name: "External visitor", submitter_email: "taylor@example.org" });
});

it("keeps a member correction pending, then replaces its target after administrator approval", async () => {
  const rows = [
    {
      id: "paper",
      name: "Example Workshop",
      deadline_aoe: "2026-09-14 23:59:00",
      deadline_label: "full paper",
      milestone: "submission",
      archival_status: "archival",
      venue_group: "Example 2026 Workshops",
      venue_id: "example",
      revisions: [],
    },
  ];
  const service = new AdminBotService(new AdminBotMemoryStore(), { deadlineDataset: () => rows });
  const proposal = unwrap(
    service.submitDeadlineProposal(
      input({ deadlineDate: "2026-09-21" }),
      "member-1",
      "correction",
      rows,
      undefined,
      "paper",
    ),
  );
  expect(service.deadlineReadModel([])).toMatchObject([{ deadline_aoe: "2026-09-14 23:59:00" }]);
  expect(
    await service.publishDeadlineProposal(proposal.id, proposal.payload_hash, {
      payload_hash: proposal.payload_hash,
      approver_role: "member" as never,
      approver_id: "member-1",
    }),
  ).toMatchObject({ ok: false });
  unwrap(
    await service.publishDeadlineProposal(proposal.id, proposal.payload_hash, {
      payload_hash: proposal.payload_hash,
      approver_role: "admin",
      approver_id: "admin-1",
    }),
  );
  expect(service.deadlineReadModel([])).toHaveLength(1);
  expect(service.deadlineReadModel([])).toMatchObject([
    {
      id: "paper",
      deadline_aoe: "2026-09-21 23:59:00",
      deadline_label: "full paper",
      venue_id: "example",
      deadline_source_status: "administrator_approved",
      revisions: [{ deadline_aoe: "2026-09-14 23:59:00" }, { deadline_aoe: "2026-09-21 23:59:00" }],
      archival_status: "archival",
      venue_group: "Example 2026 Workshops",
    },
  ]);
  rows[0].deadline_aoe = "2026-09-15 23:59:00";
  expect(service.deadlineReadModel([])).toMatchObject([{ deadline_aoe: "2026-09-21 23:59:00" }]);
});

it("rejects visitor corrections, missing targets, and approval after the target changes", async () => {
  const rows = [{ id: "paper", name: "Example Workshop", deadline_aoe: "2026-09-14 23:59:00" }];
  const service = new AdminBotService(new AdminBotMemoryStore(), { deadlineDataset: () => rows });
  expect(
    service.submitDeadlineProposal(
      input(),
      "visitor:deadline:one",
      "visitor",
      rows,
      undefined,
      "paper",
    ),
  ).toMatchObject({ ok: false });
  expect(
    service.submitDeadlineProposal(input(), "member-1", "missing", rows, undefined, "missing"),
  ).toMatchObject({ ok: false });
  const proposal = unwrap(
    service.submitDeadlineProposal(
      input({ deadlineDate: "2026-09-21" }),
      "member-1",
      "correction",
      rows,
      undefined,
      "paper",
    ),
  );
  rows[0].deadline_aoe = "2026-09-18 23:59:00";
  expect(
    await service.publishDeadlineProposal(proposal.id, proposal.payload_hash, {
      payload_hash: proposal.payload_hash,
      approver_role: "admin",
      approver_id: "admin-1",
    }),
  ).toMatchObject({ ok: false, status: 409 });
  expect(service.deadlineReadModel([])).toMatchObject([{ deadline_aoe: "2026-09-18 23:59:00" }]);
});

describe("stage-specific proposals", () => {
  const decision = {
    milestone: "notification",
    label: "Decisions",
    kind: "date" as const,
    date: "2026-09-20",
  };
  function setup() {
    const venue = {
      id: "past-venue",
      deadline_id: "past-venue",
      name: "Past Conference",
      milestone: "submission",
      deadline_aoe: "2026-07-01 23:59:00",
      schedule: [
        decision,
        { milestone: "camera_ready", label: "Camera-ready", kind: "date", date: "2026-10-01" },
      ],
    };
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store, { deadlineDataset: () => [venue] });
    return { venue, store, service };
  }
  async function publish(
    service: AdminBotService,
    proposal: ReturnType<AdminBotService["submitDeadlineProposal"]>,
  ) {
    const view = unwrap(proposal);
    return service.publishDeadlineProposal(view.id, view.payload_hash, {
      payload_hash: view.payload_hash,
      approver_role: "admin",
      approver_id: "admin-1",
    });
  }
  it("adds one date to a past venue only after approval, retaining its primary date and schedule", async () => {
    const { service } = setup();
    const proposal = service.submitDeadlineProposal(
      input({
        deadlineTime: "",
        timezone: "",
        stage: {
          milestone: "registration",
          label: "Registration",
          operation: "add",
          venueId: "past-venue",
        },
      }),
      "member-1",
      "stage-add",
    );
    expect((service.deadlineReadModel([])[0] as any).schedule).toHaveLength(2);
    expect((await publish(service, proposal)).ok).toBe(true);
    const result = service.deadlineReadModel([])[0] as any;
    expect(result.deadline_aoe).toBe("2026-07-01 23:59:00");
    expect(result.schedule).toHaveLength(3);
    expect(
      service.submitDeadlineProposal(
        input({
          deadlineTime: "",
          timezone: "",
          stage: {
            milestone: "registration",
            label: "Registration",
            operation: "add",
            venueId: "past-venue",
          },
        }),
        "member-1",
        "stage-add",
      ),
    ).toMatchObject({ ok: true, status: 200 });
    expect(result.schedule[2]).toEqual({
      milestone: "registration",
      label: "Registration",
      kind: "date",
      date: "2026-09-14",
      planning_at: "2026-09-13T10:00:00.000Z",
    });
  });
  it("corrects only the stage identified in the ellipsis and preserves the source timezone", async () => {
    const { service } = setup();
    const proposal = service.submitDeadlineProposal(
      input({
        timezone: "Europe/Zurich",
        stage: {
          milestone: "notification",
          label: "Decisions",
          operation: "correct",
          venueId: "past-venue",
          previous: stageSnapshot(decision),
        },
      }),
      "member-1",
      "stage-correct",
    );
    expect((await publish(service, proposal)).ok).toBe(true);
    const result = service.deadlineReadModel([])[0] as any;
    expect(result.deadline_aoe).toBe("2026-07-01 23:59:00");
    expect(result.schedule[0]).toMatchObject({
      milestone: "notification",
      date: "2026-09-14T21:59:00.000Z",
      timezone: "Europe/Zurich",
    });
    expect(result.schedule[1].date).toBe("2026-10-01");
  });
  it("refuses a stale correction at execution and never changes another stage", async () => {
    const { service, venue } = setup();
    const proposal = service.submitDeadlineProposal(
      input({
        stage: {
          milestone: "notification",
          label: "Decisions",
          operation: "correct",
          venueId: "past-venue",
          previous: stageSnapshot(decision),
        },
      }),
      "member-1",
      "stale-stage",
    );
    venue.schedule = [{ ...decision, date: "2026-09-22" }];
    expect(await publish(service, proposal)).toMatchObject({ ok: false, status: 409 });
    expect((service.deadlineReadModel([])[0] as any).schedule[0].date).toBe("2026-09-22");
  });
  it("rejects missing targets, duplicate stages and attempts to retarget a revision", () => {
    const { service } = setup();
    const stage = {
      milestone: "notification",
      label: "Decisions",
      operation: "add" as const,
      venueId: "past-venue",
    };
    expect(service.submitDeadlineProposal(input({ stage }), "member-1", "dup")).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(
      service.submitDeadlineProposal(
        input({ stage: { ...stage, venueId: "missing" } }),
        "member-1",
        "missing",
      ),
    ).toMatchObject({ ok: false, status: 400 });
    const proposal = unwrap(
      service.submitDeadlineProposal(
        input({ stage: { ...stage, milestone: "registration", label: "Registration" } }),
        "member-1",
        "valid",
      ),
    );
    expect(service.reviseDeadlineProposal(proposal.id, input({ stage }), "admin-1")).toMatchObject({
      ok: false,
      status: 409,
    });
  });
  it("allows a visitor to propose an additional stage but does not publish it", () => {
    const { service } = setup();
    expect(
      service.submitDeadlineProposal(
        input({
          stage: {
            milestone: "registration",
            label: "Registration",
            operation: "add",
            venueId: "past-venue",
          },
        }),
        "visitor:deadline:example",
        "visitor-stage",
      ),
    ).toMatchObject({ ok: true });
    expect((service.deadlineReadModel([])[0] as any).schedule).toHaveLength(2);
  });
});
