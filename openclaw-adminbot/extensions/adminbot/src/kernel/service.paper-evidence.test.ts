// Checking the evidence that can be checked: what gets confirmed, what gets contradicted, and what
// a pass that could not ask is careful not to claim.
import { describe, expect, it } from "vitest";
import type { AdminBotDriveProbe, AdminBotDriveProbeResult } from "../contracts/drive-links.js";
import { ADMINBOT_LAB_OVERLEAF_HOST } from "../contracts/overleaf.js";
import type { AdminBotArtifactProbe } from "../contracts/paper-artifact-links.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const FOLDER = "https://docs.google.com/document/d/1PdF9xAbCdEfGhIjKlMnOpQrStUv/edit";

function lab(probe?: AdminBotDriveProbe) {
  const service = new AdminBotService(undefined, probe ? { driveProbe: probe } : {});
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
    } as never),
  );
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Causal Garden Planning",
      authors: ["Ada Lovelace"],
      current_step: "brainstorming_docs",
      first_author_member_id: "ada",
    }),
  );
  unwrap(
    service.setPaperSlot({
      paperId: "p1",
      slot: "project_folder",
      input: { url: FOLDER },
      memberId: "ada",
      privileged: true,
    }),
  );
  return service;
}

const probeReturning = (...results: AdminBotDriveProbeResult[]): AdminBotDriveProbe => {
  const queue = [...results];
  return async () => queue.shift() ?? results.at(-1) ?? { status: "unreadable", reason: "no stub" };
};

const folderSlot = (service: AdminBotService) =>
  unwrap(service.listPaperSlots("p1")).slots.find((row) => row.slot === "project_folder");

describe("verifyPaperEvidence", () => {
  it("stamps a link Google can open, so the row says who confirmed it and when", async () => {
    const service = lab(probeReturning({ status: "found", name: "Causal Garden brainstorm" }));

    const result = unwrap(
      await service.verifyPaperEvidence("cron", { nowIso: "2026-09-13T09:00:00.000Z" }),
    );

    expect(result).toMatchObject({
      checked: 1,
      verified: [{ paper_id: "p1", slot: "project_folder" }],
    });
    expect(folderSlot(service)).toMatchObject({
      status: "provided",
      verified_by: "google_drive",
      verified_at: "2026-09-13T09:00:00.000Z",
    });
  });

  // The contradiction case, and the only one that changes a paper's state.
  it("invalidates a link Google says is not there, with a reason the author can act on", async () => {
    const service = lab(probeReturning({ status: "missing" }));

    const result = unwrap(await service.verifyPaperEvidence("cron"));

    expect(result.invalidated).toEqual([{ paper_id: "p1", slot: "project_folder" }]);
    const slot = folderSlot(service);
    expect(slot?.status).toBe("invalid");
    expect(slot?.invalid_reason).toContain("Google has no file at this link");
    // Un-settled, so the paper stops advancing on it and the nudge carries the reason.
    expect(slot?.verified_at).toBeUndefined();
  });

  // The case that must never be mistaken for the one above: a file shared with a person but not
  // with the lab's account is a sharing setting, not a wrong link.
  it("writes nothing when it could not tell", async () => {
    const service = lab(probeReturning({ status: "unreadable", reason: "permission denied" }));

    const result = unwrap(await service.verifyPaperEvidence("cron"));

    expect(result.unreadable).toEqual([
      { paper_id: "p1", slot: "project_folder", reason: "permission denied" },
    ]);
    expect(folderSlot(service)).toMatchObject({ status: "provided" });
    expect(folderSlot(service)?.verified_at).toBeUndefined();
  });

  it("confirms nothing, and complains about nothing, on a deployment with no Google wired", async () => {
    const service = lab();

    const result = unwrap(await service.verifyPaperEvidence("cron"));

    expect(result).toMatchObject({ checked: 0, verified: [], invalidated: [], unreadable: [] });
    expect(folderSlot(service)).toMatchObject({ status: "provided" });
  });

  it("asks once and leaves a confirmed row alone on the next pass", async () => {
    let calls = 0;
    const service = lab(async () => {
      calls += 1;
      return { status: "found" };
    });

    unwrap(await service.verifyPaperEvidence("cron"));
    unwrap(await service.verifyPaperEvidence("cron"));

    expect(calls).toBe(1);
  });

  // The point of recording it: a paper advanced on four ticked boxes should not read the same as
  // one advanced on three ticks and a file Google confirmed.
  it("names which of the evidence a machine confirmed when a paper advances", async () => {
    const service = lab(probeReturning({ status: "found" }));
    const give = (slot: string, input: Record<string, unknown>) =>
      unwrap(
        service.setPaperSlot({
          paperId: "p1",
          slot,
          input: input as never,
          memberId: "ada",
          privileged: true,
        }),
      );
    give("overleaf_edit", {
      url: `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6`,
    });
    for (const slot of ["papermentor_review", "fixes_merged", "pdf_ready"]) {
      give(slot, { done: true });
    }
    give("submission", { url: "https://openreview.net/forum?id=Ax7Kq2Lm9P" });
    give("submission_id", { value_text: "Ax7Kq2Lm9P" });
    // The Drive copy, confirmed by Google before the step that needs it closes.
    give("drive_pdf_arxiv", { url: FOLDER });
    unwrap(await service.verifyPaperEvidence("cron"));

    for (const slot of ["authors_ack", "pi_approval"]) {
      give(slot, { done: true });
    }
    give("arxiv_paper_password", { value_text: "k7m2q9" });

    const advance = service
      .listAuditEvents()
      .findLast((event) => event.type === "paper.stage_advanced");
    expect(advance?.details).toMatchObject({
      to: "arxiv_polish",
      evidence: ["drive_pdf_arxiv", "authors_ack", "arxiv_paper_password", "pi_approval"],
      // Three ticks and one confirmation, and the row says which was which.
      verified: ["drive_pdf_arxiv"],
    });
  });
});

describe("fixes merged, proved by a later review", () => {
  const run = (reviewedAt: string, severities: Record<string, number>) => ({
    project_id: "65f2a1c9d4e3b7a801f6",
    reviewed_at: reviewedAt,
    comments_total: Object.values(severities).reduce((sum, count) => sum + count, 0),
    by_severity: severities,
    by_category: {},
    by_document: [],
    failed_agents: [],
  });

  function reviewed() {
    const service = lab();
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "overleaf_edit",
        input: { url: `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6` },
        memberId: "ada",
        privileged: true,
      }),
    );
    return service;
  }

  const fixes = (service: AdminBotService) =>
    unwrap(service.listPaperSlots("p1")).slots.find((row) => row.slot === "fixes_merged");

  it("closes the step when the reviewer comes back with nothing serious left", () => {
    const service = reviewed();
    unwrap(
      service.recordPaperMentorRun(
        "cron",
        run("2026-09-01T09:00:00.000Z", { critical: 2, warning: 3 }),
      ),
    );
    expect(fixes(service)?.status).toBe("missing");

    unwrap(
      service.recordPaperMentorRun("cron", run("2026-09-12T09:00:00.000Z", { suggestion: 4 })),
    );

    expect(fixes(service)).toMatchObject({
      status: "provided",
      verified_by: "papermentor",
      provided_at: "2026-09-12T09:00:00.000Z",
    });
    // Credited to nobody: this is the reviewer's evidence, not an author's claim about their work.
    expect(fixes(service)?.provided_by_member_id).toBeUndefined();
  });

  it("does not close it on a count that merely dropped -- the ask is the cheap ones, not all", () => {
    const service = reviewed();
    unwrap(
      service.recordPaperMentorRun(
        "cron",
        run("2026-09-01T09:00:00.000Z", { critical: 4, warning: 6 }),
      ),
    );
    unwrap(service.recordPaperMentorRun("cron", run("2026-09-12T09:00:00.000Z", { critical: 1 })));

    expect(fixes(service)?.status).toBe("missing");
  });

  it("does not close it on a first review that was clean to begin with", () => {
    const service = reviewed();
    unwrap(
      service.recordPaperMentorRun("cron", run("2026-09-12T09:00:00.000Z", { suggestion: 2 })),
    );

    expect(fixes(service)?.status).toBe("missing");
  });
});

describe("the public record", () => {
  const ARXIV = "https://arxiv.org/abs/2601.00001";
  const FORUM = "https://openreview.net/forum?id=Ax7Kq2Lm9P";

  /** A paper far enough along to carry a submission page and an arXiv link. */
  function published(options: {
    arxivProbe?: AdminBotArtifactProbe;
    openReviewProbe?: AdminBotArtifactProbe;
  }) {
    const service = new AdminBotService(undefined, options);
    unwrap(service.upsertLabMember({ id: "ada", name: "Ada", privilege_level: "member" } as never));
    unwrap(
      service.upsertPaper({
        id: "p1",
        title: "Causal Garden Planning",
        authors: ["Ada"],
        current_step: "arxiv_polish",
        first_author_member_id: "ada",
      }),
    );
    for (const [slot, url] of [
      ["arxiv", ARXIV],
      ["submission", FORUM],
    ] as const) {
      unwrap(
        service.setPaperSlot({
          paperId: "p1",
          slot,
          input: { url },
          memberId: "ada",
          privileged: true,
        }),
      );
    }
    return service;
  }

  const slotOf = (service: AdminBotService, slot: string) =>
    unwrap(service.listPaperSlots("p1")).slots.find((row) => row.slot === slot);

  it("confirms an arXiv paper that is really there", async () => {
    const service = published({
      arxivProbe: async () => ({ status: "found", title: "Causal Garden Planning" }),
    });

    const result = unwrap(await service.verifyPaperEvidence("cron"));

    expect(result.verified).toContainEqual({ paper_id: "p1", slot: "arxiv" });
    expect(slotOf(service, "arxiv")).toMatchObject({ verified_by: "arxiv", status: "provided" });
    expect(result.mismatched).toEqual([]);
  });

  it("invalidates an arXiv id arXiv says does not exist", async () => {
    const service = published({ arxivProbe: async () => ({ status: "missing" }) });

    const result = unwrap(await service.verifyPaperEvidence("cron"));

    expect(result.invalidated).toContainEqual({ paper_id: "p1", slot: "arxiv" });
    expect(slotOf(service, "arxiv")?.invalid_reason).toContain("arXiv has no paper with this id");
  });

  // A rename is not a wrong link, so the row is left alone and a person is told instead.
  it("reports a title that is not this paper's without touching the row", async () => {
    const service = published({
      arxivProbe: async () => ({ status: "found", title: "Attention Is All You Need" }),
    });

    const result = unwrap(await service.verifyPaperEvidence("cron"));

    expect(result.mismatched).toContainEqual({
      paper_id: "p1",
      slot: "arxiv",
      found_title: "Attention Is All You Need",
    });
    expect(slotOf(service, "arxiv")).toMatchObject({ status: "provided", verified_by: "arxiv" });
  });

  it("confirms an OpenReview forum it can see", async () => {
    const service = published({
      openReviewProbe: async () => ({ status: "found", title: "Causal Garden Planning" }),
    });

    unwrap(await service.verifyPaperEvidence("cron"));

    expect(slotOf(service, "submission")).toMatchObject({ verified_by: "openreview" });
  });

  it("persists public identity, refreshes daily, and clears it when the link changes", async () => {
    let calls = 0;
    const service = published({
      openReviewProbe: async () => {
        calls++;
        return {
          status: "found",
          title: "Garden Planning Revised",
          previous_submission_id: "Older123",
          identity_review: {
            status: "checked",
            examined: 1,
            abstract_excerpt: "Source abstract",
            candidates: [],
          },
        };
      },
    });
    unwrap(await service.verifyPaperEvidence("cron", { nowIso: "2026-09-19T00:00:00Z" }));
    expect(slotOf(service, "submission")).toMatchObject({
      verified_title: "Garden Planning Revised",
      previous_submission_id: "Older123",
    });
    unwrap(await service.verifyPaperEvidence("cron", { nowIso: "2026-09-19T01:00:00Z" }));
    expect(calls).toBe(1);
    unwrap(await service.verifyPaperEvidence("cron", { nowIso: "2026-09-20T00:00:00Z" }));
    expect(calls).toBe(2);
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "submission",
        memberId: "ada",
        privileged: true,
        input: { url: "https://openreview.net/forum?id=Changed123" },
      }),
    );
    expect(slotOf(service, "submission")?.verified_title).toBeUndefined();
    expect(slotOf(service, "submission")?.previous_submission_id).toBeUndefined();
    expect(slotOf(service, "submission")?.verified_at).toBeUndefined();
    expect(slotOf(service, "submission")?.identity_review).toBeUndefined();
  });

  it("does not attach a slow response to a replacement link", async () => {
    const service = published({
      openReviewProbe: async () => {
        unwrap(
          service.setPaperSlot({
            paperId: "p1",
            slot: "submission",
            memberId: "ada",
            privileged: true,
            input: { url: "https://openreview.net/forum?id=Changed123" },
          }),
        );
        return { status: "found", title: "Old title" };
      },
    });
    unwrap(await service.verifyPaperEvidence("cron"));
    expect(slotOf(service, "submission")?.url).toContain("Changed123");
    expect(slotOf(service, "submission")?.verified_title).toBeUndefined();
  });

  it("backfills older verification stamps without titles, then removes withdrawn history on refresh", async () => {
    let calls = 0;
    const service = published({
      openReviewProbe: async () => {
        calls++;
        return calls === 1
          ? { status: "found" }
          : {
              status: "found",
              title: "Causal Garden Planning",
              ...(calls === 2 ? { previous_submission_id: "Older123" } : {}),
            };
      },
    });
    unwrap(await service.verifyPaperEvidence("cron", { nowIso: "2026-09-19T00:00:00Z" }));
    unwrap(await service.verifyPaperEvidence("cron", { nowIso: "2026-09-19T01:00:00Z" }));
    expect(slotOf(service, "submission")?.previous_submission_id).toBe("Older123");
    unwrap(await service.verifyPaperEvidence("cron", { nowIso: "2026-09-20T01:00:00Z" }));
    expect(slotOf(service, "submission")?.previous_submission_id).toBeUndefined();
  });

  // The trap this whole design is built to avoid: a paper under blind review looks exactly like a
  // paper that does not exist, and reading that as absence would invalidate every submission the
  // lab currently has in review.
  it("leaves a submission it cannot see exactly as it was", async () => {
    const service = published({
      openReviewProbe: async () => ({ status: "unreadable", reason: "blind submission" }),
    });

    const result = unwrap(await service.verifyPaperEvidence("cron"));

    expect(result.invalidated).toEqual([]);
    expect(slotOf(service, "submission")).toMatchObject({ status: "provided" });
    expect(slotOf(service, "submission")?.verified_at).toBeUndefined();
  });

  it("has nothing to ask about a venue that is not OpenReview", async () => {
    const service = published({ openReviewProbe: async () => ({ status: "found" }) });
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "submission",
        input: { url: "https://cmt3.research.microsoft.com/ACL2027/Submission/9" },
        memberId: "ada",
        privileged: true,
      }),
    );

    const result = unwrap(await service.verifyPaperEvidence("cron"));

    expect(result.unreadable).toContainEqual({
      paper_id: "p1",
      slot: "submission",
      reason: "not an OpenReview submission, so there is nothing to ask",
    });
  });
});

describe("what AdminBot posted itself", () => {
  function readyToPost() {
    const service = new AdminBotService(undefined, {
      executor: {
        execute: async () => ({
          handled: true,
          artifacts: {
            x_post: "https://x.com/i/status/1901",
            linkedin_post: "https://www.linkedin.com/feed/update/urn:li:share:1",
          },
        }),
      },
    });
    unwrap(service.upsertLabMember({ id: "ada", name: "Ada", privilege_level: "member" } as never));
    unwrap(
      service.upsertPaper({
        id: "p1",
        title: "Causal Garden Planning",
        authors: ["Ada"],
        current_step: "social_posts",
        first_author_member_id: "ada",
      }),
    );
    return service;
  }

  async function publish(service: AdminBotService) {
    const proposal = unwrap(
      service.createProposal({
        type: "social_media.post_publicly",
        summary: "Publish the paper's posts",
        target: { service: "social", channel: "x", target: "lab account" },
        proposed_payload: {
          action: "publish_paper_social_posts",
          platforms: ["x", "linkedin"],
          paper: { id: "p1", title: "Causal Garden Planning", summary: "s", authors: ["Ada"] },
          tags: { resolved: [], missing: [] },
        },
        undo_plan: "Delete the posts.",
      }),
    );
    // Two approvers: posting publicly is T4, and the quorum is re-checked at execution.
    for (const approver of ["zhijing", "andrew"]) {
      unwrap(
        service.approve(proposal.id, {
          payload_hash: proposal.payload_hash,
          approver_role: "admin",
          approver_id: approver,
        }),
      );
    }
    return await service.execute(proposal.id, { dry_run: false });
  }

  const slots = (service: AdminBotService) => unwrap(service.listPaperSlots("p1")).slots;

  it("files the URLs it created as the paper's evidence, confirmed by the act", async () => {
    const service = readyToPost();

    unwrap(await publish(service));

    const x = slots(service).find((row) => row.slot === "x_post");
    expect(x).toMatchObject({
      status: "provided",
      url: "https://x.com/i/status/1901",
      verified_by: "adminbot_post",
    });
    // Nobody pasted it, so nobody is credited with having pasted it.
    expect(x?.provided_by_member_id).toBeUndefined();
    expect(slots(service).find((row) => row.slot === "linkedin_post")).toMatchObject({
      status: "provided",
      verified_by: "adminbot_post",
    });
  });

  it("never overwrites a link somebody already filled in", async () => {
    const service = readyToPost();
    unwrap(
      service.setPaperSlot({
        paperId: "p1",
        slot: "x_post",
        input: { url: "https://x.com/lab/status/1" },
        memberId: "ada",
        privileged: true,
      }),
    );

    unwrap(await publish(service));

    expect(slots(service).find((row) => row.slot === "x_post")).toMatchObject({
      url: "https://x.com/lab/status/1",
      provided_by_member_id: "ada",
    });
  });
});
