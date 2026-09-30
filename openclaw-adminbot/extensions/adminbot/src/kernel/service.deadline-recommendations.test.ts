import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { createAdminBotSqliteService } from "../persistence/sqlite.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}
function setup(timing: Record<string, unknown> = {}) {
  const store = new AdminBotMemoryStore();
  const execute = vi.fn(async () => ({ handled: true }));
  const service = new AdminBotService(store, {
    executor: { execute },
    deadlineDataset: () => [
      {
        id: "venue",
        deadline_id: "venue",
        name: "Example Workshop",
        deadline_label: "Submission",
        deadline_date: "2035-09-25",
        deadline_aoe: "2035-09-25",
        deadline_time_precision: "date_only",
        ...timing,
      },
    ],
  });
  for (const [id, name, slack] of [
    ["ada", "Ada", "UADA"],
    ["bea", "Bea", "UBEA"],
  ]) {
    unwrap(
      service.upsertLabMember({
        id,
        name,
        slack_user_id: slack,
        privilege_level: "member",
        member_type: "full",
      }),
    );
  }
  return { service, store, execute };
}
const input = { deadline_id: "venue", recipient_member_id: "bea", reason: "Fits the topic" };

describe("deadline recommendations", () => {
  it("previews without sending; only the author can approve the exact preview", async () => {
    const { service, execute } = setup();
    const draft = unwrap(service.previewDeadlineRecommendation("ada", input));
    expect(execute).not.toHaveBeenCalled();
    expect(draft.message).toContain("Ada recommends Bea");
    expect(draft.message).toContain("2035-09-25 (time unknown)");
    expect((await service.sendDeadlineRecommendation("bea", draft.id, draft.payload_hash)).ok).toBe(
      false,
    );
    expect((await service.sendDeadlineRecommendation("ada", draft.id, "wrong")).ok).toBe(false);
    expect((await service.execute(draft.id, { dry_run: false })).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(
      unwrap(await service.sendDeadlineRecommendation("ada", draft.id, draft.payload_hash)).status,
    ).toBe("sent");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("rejects a preview after the exact cutoff changes", async () => {
    const timing = {
      deadline_at: "2035-09-25T11:30:00Z",
      deadline_timezone: "UTC",
      deadline_time_precision: "exact",
    };
    const { service, execute } = setup(timing);
    const draft = unwrap(service.previewDeadlineRecommendation("ada", input));
    expect(draft.message).toContain("2035-09-25 11:30 UTC");
    timing.deadline_at = "2035-09-26T11:30:00Z";
    expect((await service.sendDeadlineRecommendation("ada", draft.id, draft.payload_hash)).ok).toBe(
      false,
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("deduplicates previews, simultaneous sends, and subsequent edited reasons", async () => {
    const { service, execute, store } = setup();
    const first = unwrap(service.previewDeadlineRecommendation("ada", input));
    expect(unwrap(service.previewDeadlineRecommendation("ada", input)).id).toBe(first.id);
    const changed = unwrap(
      service.previewDeadlineRecommendation("ada", { ...input, reason: "Another reason" }),
    );
    await Promise.all([
      service.sendDeadlineRecommendation("ada", first.id, first.payload_hash),
      service.sendDeadlineRecommendation("ada", changed.id, changed.payload_hash),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const restarted = new AdminBotService(store);
    expect(
      unwrap(await restarted.sendDeadlineRecommendation("ada", first.id, first.payload_hash))
        .status,
    ).toBe("sent");
    expect(
      unwrap(service.previewDeadlineRecommendation("ada", { ...input, reason: "Changed again" }))
        .status,
    ).toBe("sent");
    expect(unwrap(service.deadlineRecommendationDirectory("ada")).recommendations).toHaveLength(1);
  });
  it("keeps failed delivery out of recommended-member avatars", async () => {
    const { service, execute } = setup();
    execute.mockRejectedValueOnce(new Error("Slack unavailable"));
    const draft = unwrap(service.previewDeadlineRecommendation("ada", input));
    expect((await service.sendDeadlineRecommendation("ada", draft.id, draft.payload_hash)).ok).toBe(
      false,
    );
    expect(unwrap(service.deadlineRecommendationDirectory("ada")).recommendations).toEqual([]);
  });
  it("rejects stale identities and unrelated papers; escapes Slack mentions", async () => {
    const { service } = setup();
    expect(
      service.previewDeadlineRecommendation("ada", { ...input, paper_ids: ["unrelated"] }).ok,
    ).toBe(false);
    expect(
      service.previewDeadlineRecommendation("ada", { ...input, recipient_member_id: "ada" }).ok,
    ).toBe(false);
    expect(service.previewDeadlineRecommendation("missing", input).ok).toBe(false);
    const draft = unwrap(
      service.previewDeadlineRecommendation("ada", { ...input, reason: "<!channel> <@UOTHER>" }),
    );
    expect(draft.message).not.toContain("<!channel>");
    unwrap(service.upsertLabMember({ id: "bea", name: "Bea", slack_user_id: "UNEW" }));
    expect((await service.sendDeadlineRecommendation("ada", draft.id, draft.payload_hash)).ok).toBe(
      false,
    );
  });
});

it("retains approved delivery and duplicate suppression after reopening SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deadline-recommendation-"));
  const databasePath = join(dir, "test.sqlite");
  const execute = vi.fn(async () => ({ handled: true }));
  const first = createAdminBotSqliteService({ databasePath, executor: { execute } });
  try {
    for (const [id, name, slack] of [
      ["ada", "Ada", "UADA"],
      ["bea", "Bea", "UBEA"],
    ]) {
      unwrap(
        first.service.upsertLabMember({
          id,
          name,
          slack_user_id: slack,
          privilege_level: "member",
        }),
      );
    }
    const venue = first.service.deadlineReadModel([])[0] as { deadline_id: string };
    // The service's compiled fallback is passed through its preview method.
    const { DEADLINE_VENUES } = await import("../workflows/deadlines/generated/dataset.js");
    const draft = unwrap(
      first.service.previewDeadlineRecommendation("ada", {
        ...input,
        deadline_id: venue?.deadline_id ?? DEADLINE_VENUES[0].deadline_id,
      }),
    );
    unwrap(await first.service.sendDeadlineRecommendation("ada", draft.id, draft.payload_hash));
    first.close();
    const second = createAdminBotSqliteService({ databasePath, executor: { execute } });
    try {
      expect(
        unwrap(await second.service.sendDeadlineRecommendation("ada", draft.id, draft.payload_hash))
          .status,
      ).toBe("sent");
      expect(
        unwrap(second.service.deadlineRecommendationDirectory("ada")).recommendations,
      ).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("includes multiple linked papers in one preview and one delivery, independent of selection order", async () => {
  const { service, execute } = setup();
  for (const id of ["paper-a", "paper-b"]) {
    unwrap(
      service.upsertPaper({
        id,
        title: `Title ${id}`,
        authors: ["Bea"],
        author_links: [{ name: "Bea", member_id: "bea" }],
        current_step: "submission",
      }),
    );
  }
  const first = unwrap(
    service.previewDeadlineRecommendation("ada", {
      ...input,
      paper_ids: ["paper-b", "paper-a", "paper-b"],
    }),
  );
  expect(first.message).toContain("• Title paper-a\n• Title paper-b");
  const reordered = unwrap(
    service.previewDeadlineRecommendation("ada", { ...input, paper_ids: ["paper-a", "paper-b"] }),
  );
  expect(reordered.id).toBe(first.id);
  expect(unwrap(service.previewDeadlineRecommendation("ada", { ...input, paper_ids: [] })).id).toBe(
    unwrap(service.previewDeadlineRecommendation("ada", input)).id,
  );
  expect(
    service.previewDeadlineRecommendation("ada", { ...input, paper_ids: ["paper-a", "missing"] })
      .ok,
  ).toBe(false);
  expect(
    service.previewDeadlineRecommendation("ada", {
      ...input,
      paper_ids: "paper-a" as unknown as string[],
    }).ok,
  ).toBe(false);
  expect(
    service.previewDeadlineRecommendation("ada", {
      ...input,
      paper_ids: [null] as unknown as string[],
    }).ok,
  ).toBe(false);
  unwrap(await service.sendDeadlineRecommendation("ada", first.id, first.payload_hash));
  unwrap(await service.sendDeadlineRecommendation("ada", reordered.id, reordered.payload_hash));
  expect(execute).toHaveBeenCalledTimes(1);
});

it("loads no member or paper directory for board indicators and bounds picker reads", () => {
  const { service, store } = setup();
  const members = vi.spyOn(store, "listLabMembers");
  const papers = vi.spyOn(store, "listPapers");
  expect(
    unwrap(service.deadlineRecommendationDirectory("ada", { deadlineIds: ["venue"] })).papers,
  ).toEqual([]);
  expect(members).not.toHaveBeenCalled();
  expect(papers).not.toHaveBeenCalled();
  unwrap(service.deadlineRecommendationDirectory("ada", { mode: "members", q: "Bea", offset: 50 }));
  expect(members).toHaveBeenCalledWith({ limit: 50, offset: 50, q: "Bea" });
  expect(papers).not.toHaveBeenCalled();
  unwrap(service.deadlineRecommendationDirectory("ada", { mode: "papers", recipient: "bea" }));
  expect(papers).toHaveBeenCalledWith({
    limit: 50,
    offset: 0,
    q: undefined,
    authorMemberId: "bea",
  });
});
