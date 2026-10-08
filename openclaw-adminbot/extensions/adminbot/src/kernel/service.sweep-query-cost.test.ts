import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { AdminBotSqliteStore } from "../persistence/sqlite.js";
import { AdminBotService } from "./service.js";

const NOW = "2026-05-01T12:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sqliteStore(): AdminBotSqliteStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-sweep-cost-"));
  dirs.push(dir);
  return new AdminBotSqliteStore(path.join(dir, "adminbot.sqlite"));
}

type SeedStore = AdminBotMemoryStore | AdminBotSqliteStore;

/** A lab with every per-paper table populated, and papers in each branch the sweeps look at. */
function seed(store: SeedStore, papers: number): void {
  const members = 12;
  for (let index = 0; index < members; index += 1) {
    store.saveLabMember({
      id: `m${index}`,
      // Two members share a name, so the first-author name fallback has to refuse it.
      name: index === 11 ? "Member 10" : `Member ${index}`,
      email: `m${index}@lab.org`,
      privilege_level: index === 0 ? "admin" : "member",
      slack_user_id: index % 3 === 0 ? `U${index}` : undefined,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    } as never);
  }
  for (let index = 0; index < papers; index += 1) {
    const id = `p${String(index).padStart(3, "0")}`;
    const accepted = index % 3 === 0;
    const author = `Member ${index % members}`;
    store.savePaper({
      id,
      title: `Paper ${index}`,
      venue: "NeurIPS 2026",
      deadline: `2026-05-${String((index % 27) + 2).padStart(2, "0")}`,
      authors: [author, `Member ${(index + 4) % members}`, "External Person"],
      ...(index % 4 === 0
        ? { author_links: [{ name: author, member_id: `m${index % members}` }] }
        : {}),
      ...(index % 5 === 1 ? { submitted_by_member_id: `m${(index + 1) % members}` } : {}),
      current_step: index % 7 === 0 ? "published" : "overleaf_writing",
      ...(accepted
        ? {
            venue_decision: "accept",
            accepted_venue: "NeurIPS",
            accepted_year: 2026,
            is_archival: true,
            presentation_type: "poster",
          }
        : {}),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    } as never);
    for (const slot of ["overleaf_edit", "pdf_ready", "pi_approval", "feedback_arr"] as const) {
      if ((index + slot.length) % 3 === 0) {
        continue;
      }
      store.savePaperSlot({
        paper_id: id,
        slot,
        status: index % 4 === 2 ? "invalid" : "provided",
        ...(slot === "overleaf_edit" ? { url: `https://www.overleaf.com/project/${id}abc` } : {}),
        ...(index % 4 === 2 ? { invalid_reason: "nope" } : {}),
        provided_at: "2026-04-01T00:00:00.000Z",
      } as never);
    }
    for (const platform of ["x", "linkedin"] as const) {
      store.saveSocialDraft({
        id: `${id}-${platform}`,
        paper_id: id,
        platform,
        body: `Draft for ${id}`,
        generated_at: `2026-04-0${platform === "x" ? 1 : 2}T00:00:00.000Z`,
        status: index % 2 === 0 ? "circulated" : "draft",
      } as never);
    }
    if (index % 2 === 0) {
      store.saveSocialConsent({
        draft_id: `${id}-x`,
        member_id: `m${(index + 2) % members}`,
        decision: "pending",
        asked_at: "2026-04-01T00:00:00.000Z",
      } as never);
    }
    if (accepted) {
      store.saveConferenceAttendee({
        paper_id: id,
        attendee_key: `member:m${index % members}`,
        member_id: `m${index % members}`,
        name: author,
        attending: index % 2 === 0 ? "yes" : "unknown",
      } as never);
      store.savePaperReimbursement({
        paper_id: id,
        member_id: `m${index % members}`,
        status: index % 2 === 0 ? "pending" : "submitted",
      } as never);
    }
    if (index % 2 === 1) {
      store.savePaperMentorRun({
        id: `proj${id}:2026-04-0${(index % 8) + 1}`,
        paper_id: id,
        project_id: `proj${id}`,
        reviewed_at: `2026-04-0${(index % 8) + 1}T00:00:00.000Z`,
        ingested_at: "2026-04-10T00:00:00.000Z",
        comments_total: index,
        by_severity: { major: index % 3, minor: 1 },
        by_category: {},
        by_document: [],
        failed_agents: [],
      } as never);
    }
    if (index % 3 === 1) {
      store.savePaperflowEvidence({
        paper_id: id,
        stage: "reviews_out",
        recorded_at: "2026-04-01T00:00:00.000Z",
        recorded_by: "admin",
      } as never);
    }
  }
}

/** Every read-only all-paper sweep whose per-paper reads were batched. */
function sweeps(service: AdminBotService) {
  return {
    slotOverview: service.listPaperSlotOverview(NOW),
    piReview: service.listPiReviewQueue(),
    conferences: service.listConferenceRosters(),
    paperflow: service.collectPaperflowStageNudges(NOW),
    nudgeBatches: service.collectPaperNudgeBatches(NOW),
  };
}

/** The same service with the per-sweep table snapshot switched off: one read per paper, as before. */
function perPaperReads(service: AdminBotService): AdminBotService {
  (service as unknown as { withPaperTables: <T>(sweep: () => T) => T }).withPaperTables = (
    sweep,
  ) => sweep();
  return service;
}

function countStatements(store: AdminBotSqliteStore): { executions: number } {
  const db = (store as unknown as { db: { prepare: (sql: string) => object } }).db;
  const counter = { executions: 0 };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        if (prop === "all" || prop === "get" || prop === "run" || prop === "iterate") {
          return (...args: unknown[]) => {
            counter.executions += 1;
            return (value as (...rest: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...rest: unknown[]) => unknown).bind(target);
      },
    });
  };
  return counter;
}

describe("all-paper sweeps read each per-paper table once", () => {
  it.each([
    ["memory", () => new AdminBotMemoryStore()],
    ["sqlite", sqliteStore],
  ] as const)("return byte-identical payloads to one read per paper (%s)", (_name, makeStore) => {
    const store = makeStore();
    seed(store, 30);
    const batched = JSON.stringify(sweeps(new AdminBotService(store)));
    const reference = JSON.stringify(sweeps(perPaperReads(new AdminBotService(store))));
    expect(batched).toBe(reference);
    // Not vacuous: the fixture reaches the branches the batched tables feed.
    const parsed = JSON.parse(batched);
    expect(parsed.slotOverview.payload.papers).toHaveLength(30);
    expect(parsed.conferences.payload.conferences.length).toBeGreaterThan(0);
    expect(parsed.nudgeBatches.payload.batches.length).toBeGreaterThan(0);
  });

  it("runs the same number of statements for 10 papers as for 40", () => {
    const executions = (papers: number) => {
      const store = sqliteStore();
      seed(store, papers);
      const service = new AdminBotService(store);
      const counter = countStatements(store);
      const counts: Record<string, number> = {};
      for (const [name, run] of Object.entries({
        slotOverview: () => service.listPaperSlotOverview(NOW),
        piReview: () => service.listPiReviewQueue(),
        conferences: () => service.listConferenceRosters(),
        paperflow: () => service.collectPaperflowStageNudges(NOW),
      })) {
        const before = counter.executions;
        run();
        counts[name] = counter.executions - before;
      }
      store.close();
      return counts;
    };
    const small = executions(10);
    expect(executions(40)).toEqual(small);
  });
});
