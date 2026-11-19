// The "outreach drafts are ready" note after an OpenReview sync records acceptances: once per
// venue, through propose / policy / execute / audit, and never an outreach send of its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { OpenReviewEvidence } from "../workflows/papers/openreview-paper-sync.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const NOW = "2026-10-24T08:55:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

function lab(options: { headSlack?: string } = { headSlack: "UPROF" }) {
  const sent: AdminBotStoredProposal[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal: AdminBotStoredProposal) => {
        sent.push(proposal);
        return { handled: true };
      },
    },
  });
  unwrap(service.upsertLabMember({ id: "ada", name: "Ada Lovelace", privilege_level: "member" } as never));
  unwrap(
    service.upsertLabMember({
      id: "prof",
      name: "Grace Hopper",
      privilege_level: "admin",
      ...(options.headSlack ? { slack_user_id: options.headSlack } : {}),
    } as never),
  );
  unwrap(service.updateSettings({ head_professor_member_id: "prof" } as never));
  const paper = (id: string, title: string, extra: Record<string, unknown> = {}) =>
    unwrap(
      service.upsertPaper({
        id,
        title,
        authors: ["Ada Lovelace"],
        current_step: "submission",
        first_author_member_id: "ada",
        venue: "ARR October 2026",
        ...extra,
      } as never),
    );
  paper("p1", "Causal Garden Planning");
  // Already on file as accepted at the same conference (a demo), and one at another venue.
  paper("p2", "A Demo of Gardens", {
    venue_decision: "accept",
    accepted_venue: "EMNLP 2026 System Demonstrations",
    accepted_year: 2026,
  });
  paper("p3", "Older Work", { venue_decision: "accept", accepted_venue: "ACL", accepted_year: 2025 });
  return { service, sent };
}

const accepted: OpenReviewEvidence = {
  source: "author_results",
  status: "accepted",
  title: "Causal Garden Planning",
  submission_id: "Abc123xyz",
  forums: ["Abc123xyz"],
  venue_id: "EMNLP/2026/Conference",
  track: "findings",
  presentation: "poster",
  observed_at: "2026-10-24T07:35:00+00:00",
  reference: "Abc123xyz",
};

const outreachSends = (sent: AdminBotStoredProposal[]) =>
  sent.filter((proposal) => proposal.type !== "slack.outreach_ready");

describe("acceptance -> outreach-ready nudge", () => {
  it("reports the paper the sync newly accepted, in a dry run and for real", () => {
    const { service } = lab();
    const dry = unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: true, nowIso: NOW }));
    expect(dry.newly_accepted).toEqual(["p1"]);
    const real = unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    expect(real.newly_accepted).toEqual(["p1"]);
    // Already accepted on file: not news the second time.
    const again = unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    expect(again.newly_accepted).toEqual([]);
  });

  it("DMs the head professor once for the venue, listing the whole venue, and sends no outreach", async () => {
    const { service, sent } = lab();
    const sync = unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    const report = await service.notifyOutreachReady({ paperIds: sync.newly_accepted, nowIso: NOW });

    expect(report).toEqual({
      notified: [{ venue: "EMNLP 2026", papers: 2, target: "head_professor" }],
      skipped: [],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "slack.outreach_ready",
      proposed_payload: { user_ids: ["UPROF"], venue: "EMNLP 2026", paper_ids: ["p2", "p1"] },
    });
    const message = String((sent[0]!.proposed_payload as Record<string, unknown>).message);
    expect(message).toContain("2 papers accepted at *EMNLP 2026*");
    expect(message).toContain("• Causal Garden Planning");
    expect(message).toContain("• A Demo of Gardens");
    expect(message).not.toContain("Older Work");
    expect(message).toMatch(/\/mailing-list/u);
    expect(outreachSends(sent)).toEqual([]);

    const audits = service.listAuditEvents().filter((event) => event.type === "outreach_ready.notified");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action_id: sent[0]!.id, details: { venue: "EMNLP 2026" } });

    // Said once: the same venue is silent on the next pass.
    const second = await service.notifyOutreachReady({ paperIds: ["p1"], nowIso: NOW });
    expect(second).toEqual({ notified: [], skipped: [] });
    expect(sent).toHaveLength(1);
  });

  it("posts to the admin channel when one is set", async () => {
    const { service, sent } = lab();
    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    const report = await service.notifyOutreachReady({ paperIds: ["p1"], channelId: "CADMIN", nowIso: NOW });
    expect(report.notified).toEqual([{ venue: "EMNLP 2026", papers: 2, target: "channel" }]);
    expect(sent[0]?.proposed_payload).toMatchObject({ channel_id: "CADMIN" });
    expect(sent[0]?.proposed_payload).not.toHaveProperty("user_ids");
  });

  it("skips and audits when there is nobody to tell, and can say it later", async () => {
    const { service, sent } = lab({});
    unwrap(service.syncPapersFromOpenReview({ evidence: [accepted], dryRun: false, nowIso: NOW }));
    const report = await service.notifyOutreachReady({ paperIds: ["p1"], nowIso: NOW });
    expect(report.notified).toEqual([]);
    expect(report.skipped).toEqual([
      { venue: "EMNLP 2026", reason: expect.stringContaining("no recipient") },
    ]);
    expect(sent).toEqual([]);
    expect(service.listAuditEvents().some((event) => event.type === "outreach_ready.skipped")).toBe(true);

    // Not stamped, so a later call with a recipient still announces it.
    const later = await service.notifyOutreachReady({ paperIds: ["p1"], channelId: "CADMIN", nowIso: NOW });
    expect(later.notified).toHaveLength(1);
  });

  it("does nothing for an empty acceptance list", async () => {
    const { service, sent } = lab();
    expect(await service.notifyOutreachReady({ paperIds: [] })).toEqual({ notified: [], skipped: [] });
    expect(sent).toEqual([]);
  });
});
