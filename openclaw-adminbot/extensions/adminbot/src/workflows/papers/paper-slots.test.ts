// The slot rules, tested without a store: what a write means, what shape a link must have, and
// which slots the nudge pass would actually chase.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  validateAdminBotPaperSlotUrl,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import {
  actionablePaperSlots,
  applyPaperSlotWrite,
  blankPaperSlot,
  buildPaperSlotNudgeMessage,
  isPaperClosed,
  isPaperDormant,
  paperSlotProgress,
  paperSlotRows,
  waivePaperSlot,
} from "./paper-slots.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal abstraction",
    authors: ["Ada Lovelace"],
    current_step: "overleaf_writing",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function provided(slot: AdminBotPaperSlot): AdminBotPaperSlotRecord {
  return { paper_id: "p1", slot, status: "provided", nudge_count: 0 };
}

function write(slot: AdminBotPaperSlot, input: Parameters<typeof applyPaperSlotWrite>[0]["input"]) {
  return applyPaperSlotWrite({
    existing: blankPaperSlot("p1", slot),
    input,
    memberId: "ada",
    now: NOW,
  });
}

describe("the registry", () => {
  it("declares every slot, so a read can never meet one it has no rules for", () => {
    for (const slot of adminBotPaperSlots) {
      expect(adminBotPaperSlotRegistry[slot]).toBeDefined();
    }
  });

  it("only names upstream slots that exist", () => {
    for (const slot of adminBotPaperSlots) {
      for (const upstream of adminBotPaperSlotRegistry[slot].upstream) {
        expect(adminBotPaperSlots).toContain(upstream);
      }
    }
  });

  it("gives no slot itself as an upstream, which would deadlock the walk", () => {
    for (const slot of adminBotPaperSlots) {
      expect(adminBotPaperSlotRegistry[slot].upstream).not.toContain(slot);
    }
  });

  it("only puts url rules on link slots", () => {
    for (const slot of adminBotPaperSlots) {
      const definition = adminBotPaperSlotRegistry[slot];
      if (definition.kind === "link") {
        continue;
      }
      expect(definition.urlHosts).toBeUndefined();
      expect(definition.urlPath).toBeUndefined();
    }
  });
});

describe("paperSlotRows", () => {
  it("returns every slot, blanks included -- the card is a checklist, not a list of answers", () => {
    const rows = paperSlotRows("p1", [provided("overleaf")]);
    expect(rows).toHaveLength(adminBotPaperSlots.length);
    expect(rows.find((row) => row.slot === "overleaf")?.status).toBe("provided");
    expect(rows.find((row) => row.slot === "arxiv")?.status).toBe("missing");
  });
});

describe("URL shape validation", () => {
  it("accepts the real thing", () => {
    expect(
      validateAdminBotPaperSlotUrl("overleaf", "https://www.overleaf.com/project/64ab"),
    ).toEqual({ ok: true });
    expect(validateAdminBotPaperSlotUrl("arxiv", "https://arxiv.org/abs/2601.00001")).toEqual({
      ok: true,
    });
  });

  it("refuses http, so a stored link is never a downgrade", () => {
    const result = validateAdminBotPaperSlotUrl("arxiv", "http://arxiv.org/abs/2601.00001");
    expect(result).toEqual({
      ok: false,
      reason: "the link must start with https://",
    });
  });

  it("refuses the wrong host and the wrong path separately, so the reason is actionable", () => {
    expect(validateAdminBotPaperSlotUrl("arxiv", "https://example.com/abs/1")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("arxiv.org"),
    });
    expect(validateAdminBotPaperSlotUrl("arxiv", "https://arxiv.org/pdf/2601.00001")).toMatchObject(
      {
        ok: false,
        reason: expect.stringContaining("/abs/"),
      },
    );
  });

  it("takes a subdomain of an allowed host, since that is the URL people actually copy", () => {
    expect(validateAdminBotPaperSlotUrl("x_post", "https://www.x.com/lab/status/1")).toEqual({
      ok: true,
    });
  });

  it("lets an any-https slot through", () => {
    expect(validateAdminBotPaperSlotUrl("brainstorm_doc", "https://example.com/doc")).toEqual({
      ok: true,
    });
  });
});

describe("applyPaperSlotWrite", () => {
  it("derives provided from the value, so nothing can declare itself done", () => {
    const result = write("brainstorm_doc", { url: "https://example.com/doc" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.record.status).toBe("provided");
    expect(result.record.provided_by_member_id).toBe("ada");
    expect(result.record.validated_at).toBe(NOW.toISOString());
  });

  it("keeps a malformed link and marks it invalid rather than throwing it away", () => {
    const result = write("arxiv", { url: "https://arxiv.org/pdf/2601.00001" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.record.status).toBe("invalid");
    // The author has to be able to see what they pasted next to the reason it was refused.
    expect(result.record.url).toBe("https://arxiv.org/pdf/2601.00001");
    expect(result.record.invalid_reason).toContain("/abs/");
    expect(result.record.validated_at).toBeUndefined();
  });

  it("marks a bool slot done with no URL at all", () => {
    const result = write("pdf_ready", { done: true });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.record.status).toBe("provided");
    expect(result.record.url).toBeUndefined();
  });

  it("clearing a slot keeps the nudge counters, so the escalation clock cannot be reset", () => {
    const existing: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "pdf_ready",
      status: "provided",
      nudge_count: 4,
      last_nudged_at: "2026-08-01T00:00:00.000Z",
    };
    const result = applyPaperSlotWrite({
      existing,
      input: { done: false },
      memberId: "ada",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.record.status).toBe("missing");
    expect(result.record.nudge_count).toBe(4);
    expect(result.record.last_nudged_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("refuses to overwrite a waived slot, so an autosave cannot undo an admin override", () => {
    const existing: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "poster",
      status: "waived",
      nudge_count: 0,
    };
    const result = applyPaperSlotWrite({
      existing,
      input: { url: "https://example.com/p.pdf" },
      memberId: "ada",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("bounds a snooze", () => {
    const far = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(write("overleaf", { snoozed_until: far })).toMatchObject({
      ok: false,
    });
    const near = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(write("overleaf", { snoozed_until: near })).toMatchObject({
      ok: true,
    });
  });
});

describe("waivePaperSlot", () => {
  it("insists on a reason -- a waiver nobody can explain later is just missing data", () => {
    expect(
      waivePaperSlot({
        existing: blankPaperSlot("p1", "poster"),
        memberId: "zhijing",
        reason: "  ",
        now: NOW,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("actionablePaperSlots", () => {
  it("asks only for what is unblocked", () => {
    const open = actionablePaperSlots(paper(), [], NOW);
    // Nothing is on file, so the only thing anybody can do is the brainstorm doc.
    expect(open.map((entry) => entry.slot)).toEqual(["brainstorm_doc"]);
  });

  it("opens the next slot once its upstream is in", () => {
    const open = actionablePaperSlots(paper(), [provided("brainstorm_doc")], NOW);
    expect(open.map((entry) => entry.slot)).toEqual(["overleaf"]);
  });

  it("counts a waiver as settled, so an override really does unblock what came after it", () => {
    const waived: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "brainstorm_doc",
      status: "waived",
      nudge_count: 0,
    };
    expect(actionablePaperSlots(paper(), [waived], NOW).map((entry) => entry.slot)).toEqual([
      "overleaf",
    ]);
  });

  it("chases an invalid link -- it is answered but unusable, which is not done", () => {
    const invalid: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "brainstorm_doc",
      status: "invalid",
      nudge_count: 0,
      invalid_reason: "that is not a URL",
    };
    expect(actionablePaperSlots(paper(), [invalid], NOW).map((entry) => entry.slot)).toEqual([
      "brainstorm_doc",
    ]);
  });

  it("skips a snoozed slot until its clock runs out", () => {
    const snoozed: AdminBotPaperSlotRecord = {
      ...blankPaperSlot("p1", "brainstorm_doc"),
      snoozed_until: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    expect(actionablePaperSlots(paper(), [snoozed], NOW)).toEqual([]);
    const expired: AdminBotPaperSlotRecord = {
      ...snoozed,
      snoozed_until: new Date(NOW.getTime() - 60_000).toISOString(),
    };
    expect(actionablePaperSlots(paper(), [expired], NOW)).toHaveLength(1);
  });

  it("never chases the advisory slot, which blocks nothing", () => {
    const open = actionablePaperSlots(paper(), [], NOW);
    expect(open.map((entry) => entry.slot)).not.toContain("backend_sheet");
  });

  it("ranks venue work above the rest when several are open at once", () => {
    const done = (
      ["brainstorm_doc", "overleaf", "papermentor_review", "fixes_merged", "pdf_ready"] as const
    ).map(provided);
    const open = actionablePaperSlots(paper(), [...done], NOW);
    // Submission (venue) and the talk slides (talk) are both unblocked by a compiled PDF.
    expect(open[0]?.slot).toBe("submission");
    expect(open.map((entry) => entry.slot)).toContain("slides");
    expect(open.map((entry) => entry.slot).indexOf("slides")).toBeGreaterThan(0);
  });

  it("says nothing about a dormant or a rejected paper", () => {
    const old = paper({ created_at: "2020-01-01T00:00:00.000Z" });
    expect(isPaperDormant(old, NOW)).toBe(true);
    expect(actionablePaperSlots(old, [], NOW)).toEqual([]);

    const rejected = paper({ venue_decision: "reject" });
    expect(isPaperClosed(rejected)).toBe(true);
    expect(actionablePaperSlots(rejected, [], NOW)).toEqual([]);
  });

  it("honours the admin dormancy override", () => {
    const old = paper({
      created_at: "2020-01-01T00:00:00.000Z",
      dormant_override: true,
    });
    expect(isPaperDormant(old, NOW)).toBe(false);
    expect(actionablePaperSlots(old, [], NOW)).toHaveLength(1);
  });

  it("escalates a deadline-bearing slot only once it has been nudged enough", () => {
    const nagged: AdminBotPaperSlotRecord = {
      ...blankPaperSlot("p1", "overleaf"),
      nudge_count: 3,
    };
    const [entry] = actionablePaperSlots(paper(), [provided("brainstorm_doc"), nagged], NOW);
    expect(entry?.escalate).toBe(true);
  });
});

describe("paperSlotProgress", () => {
  it("leaves the advisory slot out of the denominator, so the bar can reach the end", () => {
    const { total } = paperSlotProgress([]);
    expect(total).toBe(adminBotPaperSlots.length - 1);
  });
});

describe("buildPaperSlotNudgeMessage", () => {
  it("names the artifacts, not the step", () => {
    const entries = actionablePaperSlots(paper(), [], NOW);
    const message = buildPaperSlotNudgeMessage({
      paper: paper(),
      entries,
      now: NOW,
    });
    expect(message).toContain("Causal abstraction");
    expect(message).toContain("Brainstorm doc");
  });

  it("mentions a deadline only when the paper carries one", () => {
    const entries = actionablePaperSlots(paper(), [], NOW);
    expect(buildPaperSlotNudgeMessage({ paper: paper(), entries, now: NOW })).not.toContain(
      "deadline",
    );
    const dated = paper({ venue: "ICLR 2027", deadline: "2026-08-27" });
    const message = buildPaperSlotNudgeMessage({
      paper: dated,
      entries,
      now: NOW,
    });
    expect(message).toContain("ICLR 2027 deadline is in 7 days");
  });

  it("repeats why a link was refused, so the fix is in the message", () => {
    const invalid: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "brainstorm_doc",
      status: "invalid",
      nudge_count: 0,
      invalid_reason: "that is not a URL",
    };
    const entries = actionablePaperSlots(paper(), [invalid], NOW);
    expect(buildPaperSlotNudgeMessage({ paper: paper(), entries, now: NOW })).toContain(
      "that is not a URL",
    );
  });
});
