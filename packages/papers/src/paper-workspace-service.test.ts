import { describe, expect, it, vi } from "vitest";
import type { PaperRecord, PaperRepository, TransactionBoundary } from "@adminbot/ports";
import { PaperWorkspaceService, type PaperActor } from "./paper-workspace-service.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const AUTHOR_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_ID = "20000000-0000-4000-8000-000000000002";
const PAPER_ID = "30000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-08T12:00:00Z");

describe("PaperWorkspaceService", () => {
  it("projects a deterministic Gantt and administrator nudges", async () => {
    const fixture = harness([paper({ deadlineAt: new Date("2026-08-10T12:00:00Z") })]);
    const result = await fixture.service.list(actor("administrator", AUTHOR_ID));

    expect(result).toMatchObject({ ok: true, status: 200 });
    if (!result.ok || result.body === undefined || !("papers" in result.body)) throw new Error("expected workspace");
    expect(result.body.papers[0]?.timeline).toMatchObject({ progressPercent: 20, totalEstimatedBusinessDays: 38 });
    expect(result.body.papers[0]?.timeline.items.find(({ state }) => state === "current")?.stage).toBe("drafting");
    expect(result.body.nudges).toHaveLength(1);
    expect(result.body.nudges[0]).toMatchObject({ kind: "author_nudge", recipientIds: [AUTHOR_ID] });
  });

  it("allows authors to edit content but rejects authorship escalation", async () => {
    const fixture = harness([paper()]);
    const allowed = await fixture.service.update(actor("member", AUTHOR_ID), PAPER_ID, {
      paperId: PAPER_ID,
      expectedVersion: 1,
      title: "Updated title",
      stage: "internal_review",
    });
    const denied = await fixture.service.update(actor("member", AUTHOR_ID), PAPER_ID, {
      paperId: PAPER_ID,
      expectedVersion: 2,
      authorIds: [OTHER_ID],
    });

    expect(allowed).toMatchObject({ ok: true, status: 200 });
    expect(denied).toMatchObject({ ok: false, status: 403, body: { code: "not_authorized" } });
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "papers.paper_updated" }));
  });

  it("requires a recently authenticated administrator for deletion", async () => {
    const fixture = harness([paper()]);
    const member = await fixture.service.delete(actor("member", AUTHOR_ID), PAPER_ID, { paperId: PAPER_ID, expectedVersion: 1 });
    const staleAdmin = await fixture.service.delete({ ...actor("administrator", OTHER_ID), authenticationLevel: "single_factor" }, PAPER_ID, { paperId: PAPER_ID, expectedVersion: 1 });
    const administrator = await fixture.service.delete(actor("administrator", OTHER_ID), PAPER_ID, { paperId: PAPER_ID, expectedVersion: 1 });

    expect(member).toMatchObject({ ok: false, status: 403 });
    expect(staleAdmin).toMatchObject({ ok: false, status: 403 });
    expect(administrator).toMatchObject({ ok: true, status: 200 });
  });

  it("fails closed for anonymous readers and stale writes", async () => {
    const fixture = harness([paper()]);
    await expect(fixture.service.list(undefined)).resolves.toMatchObject({ ok: false, status: 401 });
    await expect(fixture.service.update(actor("member", AUTHOR_ID), PAPER_ID, { paperId: PAPER_ID, expectedVersion: 9, title: "stale" })).resolves.toMatchObject({ ok: false, status: 409, body: { code: "conflict" } });
  });

  it("keeps external collaborators read-only", async () => {
    const fixture = harness([paper()]);
    const external = { ...actor("member", AUTHOR_ID), roles: ["external_collaborator"] as const };
    await expect(fixture.service.list(external)).resolves.toMatchObject({ ok: true });
    await expect(fixture.service.create(external, { title: "No write", authorIds: [AUTHOR_ID] })).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(fixture.service.update(external, PAPER_ID, { paperId: PAPER_ID, expectedVersion: 1, title: "No write" })).resolves.toMatchObject({ ok: false, status: 403 });
  });
});

function harness(initial: PaperRecord[]) {
  let rows = [...initial];
  const audit = vi.fn(async () => undefined);
  const outbox = vi.fn(async () => undefined);
  const papers: PaperRepository = {
    list: async () => rows,
    find: async (_organizationId, id) => rows.find((row) => row.id === id),
    create: async (input) => {
      const created = paper({ ...input, authorNames: ["Author One"], version: 1, createdAt: input.now, updatedAt: input.now });
      rows.push(created);
      return created;
    },
    update: async (input) => {
      const current = rows.find((row) => row.id === input.id);
      if (!current) return "not_found";
      if (current.version !== input.expectedVersion) return "conflict";
      const updated = { ...current, ...input, targetVenue: input.targetVenue ?? undefined, deadlineAt: input.deadlineAt ?? undefined, sourceUri: input.sourceUri ?? undefined, version: current.version + 1, updatedAt: input.now } as PaperRecord;
      rows = rows.map((row) => row.id === input.id ? updated : row);
      return updated;
    },
    delete: async (_organizationId, id, version) => {
      const current = rows.find((row) => row.id === id);
      if (!current) return "not_found";
      if (current.version !== version) return "conflict";
      rows = rows.filter((row) => row.id !== id);
      return "deleted";
    },
  };
  const unit = { papers, audit: { append: audit }, outbox: { enqueue: outbox } };
  const transactions = {
    read: async (work: (value: typeof unit) => Promise<unknown>) => work(unit),
    write: async (work: (value: typeof unit) => Promise<unknown>) => work(unit),
  } as unknown as TransactionBoundary;
  return {
    audit,
    service: new PaperWorkspaceService({ transactions, organizationId: ORGANIZATION_ID, now: () => NOW, createId: () => "40000000-0000-4000-8000-000000000001" }),
  };
}

function actor(role: "administrator" | "member", personId: string): PaperActor {
  return { accountId: "50000000-0000-4000-8000-000000000001", organizationId: ORGANIZATION_ID, personId, roles: [role], authenticationLevel: "recent_reauthentication" };
}

function paper(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return { id: PAPER_ID, organizationId: ORGANIZATION_ID, title: "Synthetic Paper", authorIds: [AUTHOR_ID], authorNames: ["Author One"], stage: "drafting", targetVenue: "NeurIPS 2026", topicTags: ["systems"], version: 1, createdAt: NOW, updatedAt: NOW, ...overrides };
}
