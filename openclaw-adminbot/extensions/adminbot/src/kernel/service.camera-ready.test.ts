// End to end through the service: a lab paper accepted at a venue the deadline dataset does not
// track gets its camera-ready on the deadlines read model, on the PI's queue, and as a lab
// calendar proposal that waits for an admin. Synthetic venue, paper and people throughout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";
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

const NOW = "2026-11-10T08:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

function lab() {
  const store = new AdminBotMemoryStore();
  const execute = vi.fn(async () => ({ handled: true }));
  const service = new AdminBotService(store, { executor: { execute } });
  unwrap(
    service.upsertLabMember({ id: "ada", name: "Ada Test", privilege_level: "member" } as never),
  );
  unwrap(
    service.upsertLabMember({ id: "pi", name: "Pat Test", privilege_level: "admin" } as never),
  );
  unwrap(service.updateSettings({ head_professor_member_id: "pi" } as never));
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Synthetic Causal Benchmark",
      authors: ["Ada Test"],
      current_step: "submission",
      first_author_member_id: "ada",
      venue: "SynthConf 2027",
    }),
  );
  return { store, service, execute };
}

// "SynthConf" is in neither the curated dataset nor the collector's lists, as NeurIPS was not.
const accepted: OpenReviewEvidence = {
  source: "author_results",
  status: "accepted",
  title: "Synthetic Causal Benchmark",
  submission_id: "Syn999",
  forums: ["Syn999"],
  venue_id: "SynthConf.cc/2027/Conference",
  observed_at: "2026-11-09T12:00:00+00:00",
  reference: "Syn999",
};

const cameraReadyTask = {
  kind: "camera_ready" as const,
  name: "Camera Ready Revision",
  due: "2027-01-20T11:59:00+00:00",
  open: true,
  forms: 1,
  done: 0,
};

const rowsFor = (service: AdminBotService) =>
  service
    .deadlineReadModel(DEADLINE_VENUES)
    .map((row) => row as Record<string, unknown>)
    .filter((row) => String(row.id).startsWith("synthconf2027"));

const holds = (store: AdminBotMemoryStore) =>
  store
    .listProposalsByType("calendar.create_tentative_hold")
    .filter((proposal) => proposal.target?.camera_ready_venue === "synthconf2027");

describe("camera-ready deadlines for an untracked venue", () => {
  it("is not on the board before OpenReview shows the camera-ready form", () => {
    const { service, store } = lab();
    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    expect(rowsFor(service)).toEqual([]);
    expect(holds(store)).toEqual([]);
  });

  it("puts the camera-ready on the deadlines read model and the PI's notice", () => {
    const { service, store } = lab();
    unwrap(
      service.syncPapersFromOpenReview({
        evidence: [{ ...accepted, author_tasks: [cameraReadyTask] }],
        dryRun: false,
        nowIso: NOW,
      }),
    );
    expect(rowsFor(service)).toEqual([
      expect.objectContaining({
        id: "synthconf2027_camera_ready_openreview",
        venue_group: "SynthConf 2027",
        milestone: "camera_ready",
        deadline_aoe: "2027-01-19 23:59:00",
        deadline_at: "2027-01-20T11:59:00.000Z",
      }),
    ]);
    const [notice] = store.listMemberNotifications("pi");
    expect(notice?.title).toBe("Accepted at SynthConf 2027: camera-ready");
    expect(notice?.body).toContain("Camera-ready is due 2027-01-20");
  });

  it("records a camera-ready form that opens after the acceptance was applied", () => {
    const { service } = lab();
    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    const later = unwrap(
      service.syncPapersFromOpenReview({
        evidence: [{ ...accepted, author_tasks: [cameraReadyTask] }],
        dryRun: false,
        nowIso: NOW,
      }),
    );
    expect(later.unchanged).toBe(1);
    expect(rowsFor(service).map((row) => row.deadline_at)).toEqual(["2027-01-20T11:59:00.000Z"]);
  });

  it("writes nothing in a dry run", () => {
    const { service, store } = lab();
    unwrap(
      service.syncPapersFromOpenReview({
        evidence: [{ ...accepted, author_tasks: [cameraReadyTask] }],
        dryRun: true,
        nowIso: NOW,
      }),
    );
    expect(rowsFor(service)).toEqual([]);
    expect(holds(store)).toEqual([]);
  });

  it("proposes one lab-calendar entry that waits for an admin, and only once", () => {
    const { service, store, execute } = lab();
    const live = { ...accepted, author_tasks: [cameraReadyTask] };
    unwrap(service.syncPapersFromOpenReview({ evidence: [live], dryRun: false, nowIso: NOW }));
    unwrap(service.syncPapersFromOpenReview({ evidence: [live], dryRun: false, nowIso: NOW }));
    const [hold, ...rest] = holds(store);
    expect(rest).toEqual([]);
    expect(hold).toMatchObject({
      status: "pending",
      target: { camera_ready_venue: "synthconf2027", camera_ready_due: "2027-01-20T11:59:00.000Z" },
      proposed_payload: {
        summary: "SynthConf 2027 camera-ready due (AoE)",
        from: "2027-01-19",
        to: "2027-01-20",
        all_day: true,
      },
    });
    // Nothing reaches the calendar until it is approved.
    expect(execute).not.toHaveBeenCalled();
  });

  it("withdraws the pending entry and proposes a new one when the date moves", () => {
    const { service, store } = lab();
    unwrap(
      service.syncPapersFromOpenReview({
        evidence: [{ ...accepted, author_tasks: [cameraReadyTask] }],
        dryRun: false,
        nowIso: NOW,
      }),
    );
    unwrap(
      service.syncPapersFromOpenReview({
        evidence: [
          { ...accepted, author_tasks: [{ ...cameraReadyTask, due: "2027-01-27T11:59:00+00:00" }] },
        ],
        dryRun: false,
        nowIso: NOW,
      }),
    );
    const byDue = Object.fromEntries(
      holds(store).map((proposal) => [proposal.target?.camera_ready_due, proposal.status]),
    );
    expect(byDue["2027-01-27T11:59:00.000Z"]).toBe("pending");
    expect(byDue["2027-01-20T11:59:00.000Z"]).not.toBe("pending");
  });
});
