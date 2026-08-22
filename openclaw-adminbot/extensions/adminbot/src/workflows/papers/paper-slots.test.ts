// The slot rules, tested without a store: what a write means, what shape a value must have, and
// which slots the nudge sweep would actually chase.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotSocialDraftRecord } from "../../contracts/paper-cycle.js";
import {
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  validateAdminBotPaperSecret,
  validateAdminBotPaperSlotUrl,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import {
  actionablePaperSlots,
  applyPaperSlotWrite,
  blankPaperSlot,
  boundSnooze,
  buildNudgeMessage,
  draftConsentState,
  isConferenceBranchOpen,
  isCycleClosed,
  isNudgeDue,
  isPaperClosed,
  isPaperDormant,
  missingAcceptanceDetails,
  paperSlotProgress,
  paperSlotRows,
  redactPaperSlots,
  resolveConsentAudience,
  waivePaperSlot,
} from "./paper-slots.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

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
  return { paper_id: "p1", slot, status: "provided" };
}

function write(slot: AdminBotPaperSlot, input: Parameters<typeof applyPaperSlotWrite>[0]["input"]) {
  return applyPaperSlotWrite({
    existing: blankPaperSlot("p1", slot),
    input,
    memberId: "ada",
    now: NOW,
  });
}

/** Everything up to and including a slot, so a test can start partway down the pipeline. */
function upTo(last: AdminBotPaperSlot): AdminBotPaperSlotRecord[] {
  const out: AdminBotPaperSlot[] = [];
  const walk = (slot: AdminBotPaperSlot) => {
    for (const up of adminBotPaperSlotRegistry[slot].upstream) {
      walk(up);
    }
    if (!out.includes(slot)) {
      out.push(slot);
    }
  };
  walk(last);
  return out.map(provided);
}

describe("the registry", () => {
  it("declares every slot, so a read can never meet one it has no rules for", () => {
    expect(adminBotPaperSlots).toHaveLength(24);
    for (const slot of adminBotPaperSlots) {
      expect(adminBotPaperSlotRegistry[slot]).toBeDefined();
    }
  });

  it("only names upstream slots that exist, and never itself", () => {
    for (const slot of adminBotPaperSlots) {
      for (const upstream of adminBotPaperSlotRegistry[slot].upstream) {
        expect(adminBotPaperSlots).toContain(upstream);
      }
      expect(adminBotPaperSlotRegistry[slot].upstream).not.toContain(slot);
    }
  });

  it("has no upstream cycle, which would stall the walk on a paper forever", () => {
    for (const slot of adminBotPaperSlots) {
      const seen = new Set<AdminBotPaperSlot>();
      const queue = [...adminBotPaperSlotRegistry[slot].upstream];
      while (queue.length > 0) {
        const current = queue.shift() as AdminBotPaperSlot;
        expect(current).not.toBe(slot);
        if (seen.has(current)) {
          continue;
        }
        seen.add(current);
        queue.push(...adminBotPaperSlotRegistry[current].upstream);
      }
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

  it("keeps the read-only Overleaf link advisory, so a project that only has an edit link is not stuck", () => {
    // Both Overleaf slots gate the same step. If both were required, every project that
    // circulates only the edit link would sit on an open checklist item forever.
    expect(adminBotPaperSlotRegistry.overleaf_edit.required).toBe(true);
    expect(adminBotPaperSlotRegistry.overleaf_view.required).toBe(false);
  });

  it("no longer carries the slots the revision removed", () => {
    expect(adminBotPaperSlots as readonly string[]).not.toContain("drive_pdf_submitted");
    expect(adminBotPaperSlots as readonly string[]).not.toContain("shared_folder");
    expect(adminBotPaperSlots as readonly string[]).not.toContain("brainstorm_doc");
  });
});

describe("paperSlotRows", () => {
  it("returns every slot, blanks included -- the card is a checklist, not a list of answers", () => {
    const rows = paperSlotRows("p1", [provided("overleaf_edit")]);
    expect(rows).toHaveLength(24);
    expect(rows.find((row) => row.slot === "overleaf_edit")?.status).toBe("provided");
    expect(rows.find((row) => row.slot === "arxiv")?.status).toBe("missing");
  });

  it("reads the social gates off the drafts rather than off their own rows", () => {
    const draft: AdminBotSocialDraftRecord = {
      id: "d1",
      paper_id: "p1",
      platform: "x",
      body: "hello",
      generated_at: NOW.toISOString(),
      status: "approved",
    };
    const rows = paperSlotRows("p1", [], [draft]);
    expect(rows.find((row) => row.slot === "x_draft")?.status).toBe("provided");
    expect(rows.find((row) => row.slot === "linkedin_draft")?.status).toBe("missing");
  });

  it("does not let a superseded draft keep the gate open", () => {
    const superseded: AdminBotSocialDraftRecord = {
      id: "d1",
      paper_id: "p1",
      platform: "x",
      body: "old",
      generated_at: NOW.toISOString(),
      status: "superseded",
    };
    expect(
      paperSlotRows("p1", [], [superseded]).find((row) => row.slot === "x_draft")?.status,
    ).toBe("missing");
  });

  it("lets a waiver beat the derived value, or an admin override would be silently undone", () => {
    const waived: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "x_draft",
      status: "waived",
      waived_reason: "no social push for this one",
    };
    expect(paperSlotRows("p1", [waived], []).find((row) => row.slot === "x_draft")?.status).toBe(
      "waived",
    );
  });
});

describe("value validation", () => {
  it("accepts the real thing", () => {
    expect(
      validateAdminBotPaperSlotUrl("overleaf_edit", "https://www.overleaf.com/project/64ab"),
    ).toEqual({ ok: true });
    expect(validateAdminBotPaperSlotUrl("arxiv", "https://arxiv.org/abs/2601.00001")).toEqual({
      ok: true,
    });
  });

  it("separates the two Overleaf links by path, since that is what makes them different", () => {
    expect(
      validateAdminBotPaperSlotUrl("overleaf_view", "https://www.overleaf.com/project/64ab"),
    ).toMatchObject({ ok: false });
    expect(
      validateAdminBotPaperSlotUrl("overleaf_view", "https://www.overleaf.com/read/abcdef"),
    ).toEqual({ ok: true });
  });

  it("takes a Drive folder as well as a doc for the project folder", () => {
    expect(
      validateAdminBotPaperSlotUrl("project_folder", "https://docs.google.com/document/d/xyz"),
    ).toEqual({ ok: true });
    expect(
      validateAdminBotPaperSlotUrl("project_folder", "https://drive.google.com/drive/folders/xyz"),
    ).toEqual({ ok: true });
    expect(
      validateAdminBotPaperSlotUrl("project_folder", "https://drive.google.com/file/d/xyz"),
    ).toMatchObject({ ok: false });
  });

  it("refuses http, so a stored link is never a downgrade", () => {
    expect(validateAdminBotPaperSlotUrl("arxiv", "http://arxiv.org/abs/1")).toEqual({
      ok: false,
      reason: "the link must start with https://",
    });
  });

  it("takes a subdomain of an allowed host, since that is the URL people actually copy", () => {
    expect(validateAdminBotPaperSlotUrl("x_post", "https://www.x.com/lab/status/1")).toEqual({
      ok: true,
    });
  });

  it("holds the arXiv password to six mixed characters", () => {
    expect(validateAdminBotPaperSecret("a1b2c3")).toEqual({ ok: true });
    expect(validateAdminBotPaperSecret("abcdef")).toMatchObject({ ok: false });
    expect(validateAdminBotPaperSecret("123456")).toMatchObject({ ok: false });
    expect(validateAdminBotPaperSecret("a1b2c")).toMatchObject({ ok: false });
    expect(validateAdminBotPaperSecret("a1b2c3d")).toMatchObject({ ok: false });
  });
});

describe("applyPaperSlotWrite", () => {
  it("derives provided from the value, so nothing can declare itself done", () => {
    const result = write("project_folder", { url: "https://docs.google.com/document/d/x" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.record.status).toBe("provided");
    expect(result.record.provided_by_member_id).toBe("ada");
  });

  it("keeps a malformed link and marks it invalid rather than throwing it away", () => {
    const result = write("arxiv", { url: "https://arxiv.org/pdf/2601.00001" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.record.status).toBe("invalid");
    expect(result.record.url).toBe("https://arxiv.org/pdf/2601.00001");
    expect(result.record.invalid_reason).toContain("/abs/");
  });

  it("refuses a bad credential instead of storing it, unlike every other kind", () => {
    // The usual kindness -- keep what they typed so they can see it -- is the wrong call for a
    // password: a mistyped one is still a password somebody uses, and it would sit in a row every
    // author of the paper can read.
    const result = write("arxiv_paper_password", { value_text: "abcdef" });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toContain("letters and digits");
  });

  it("takes an enum state with its free-text note", () => {
    const result = write("poster_physical", { value_text: "printed", value_note: "in the lab" });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.record).toMatchObject({
      status: "provided",
      value_text: "printed",
      value_note: "in the lab",
    });
  });

  it("refuses an enum value that is not one of the states", () => {
    expect(write("poster_physical", { value_text: "laminated" })).toMatchObject({ ok: false });
  });

  it("refuses a direct write to a derived slot", () => {
    // The drafts table is the source of truth for these two; a second writable copy would be free
    // to disagree with it.
    expect(write("x_draft", { done: true })).toMatchObject({ ok: false });
  });

  it("refuses to overwrite a waived slot, so an autosave cannot undo an admin override", () => {
    const existing: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "poster",
      status: "waived",
    };
    expect(
      applyPaperSlotWrite({
        existing,
        input: { url: "https://example.com/p.pdf" },
        memberId: "ada",
        now: NOW,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("redactPaperSlots", () => {
  it("drops the credential for a reader who is not entitled, rather than blanking it", () => {
    const rows: AdminBotPaperSlotRecord[] = [
      { paper_id: "p1", slot: "arxiv_paper_password", status: "provided", value_text: "a1b2c3" },
    ];
    const [redacted] = redactPaperSlots(rows, false);
    // Blanking would still tell the reader whether a password exists, which is itself a
    // disclosure about the paper's state.
    expect(redacted).not.toHaveProperty("value_text");
    expect(redacted?.status).toBe("provided");
    expect(redactPaperSlots(rows, true)[0]?.value_text).toBe("a1b2c3");
  });
});

describe("actionablePaperSlots", () => {
  it("asks only for what is unblocked", () => {
    expect(actionablePaperSlots(paper(), [], NOW).map((item) => item.slot)).toEqual([
      "project_folder",
    ]);
  });

  it("skips the advisory read-only Overleaf link and goes straight to the edit one", () => {
    expect(
      actionablePaperSlots(paper(), [provided("project_folder")], NOW).map((item) => item.slot),
    ).toEqual(["overleaf_edit"]);
  });

  it("counts a waiver as settled, so an override really does unblock what came after it", () => {
    const waived: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "project_folder",
      status: "waived",
      waived_reason: "predates AdminBot",
    };
    expect(actionablePaperSlots(paper(), [waived], NOW).map((item) => item.slot)).toEqual([
      "overleaf_edit",
    ]);
  });

  it("chases an invalid link -- it is answered but unusable, which is not done", () => {
    const invalid: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "project_folder",
      status: "invalid",
      invalid_reason: "that is not a URL",
    };
    expect(actionablePaperSlots(paper(), [invalid], NOW).map((item) => item.slot)).toEqual([
      "project_folder",
    ]);
  });

  it("never chases an advisory slot, which blocks nothing", () => {
    const open = actionablePaperSlots(paper(), upTo("poster"), NOW).map((item) => item.slot);
    expect(open).not.toContain("poster_physical");
    expect(open).not.toContain("backend_sheet");
    expect(open).not.toContain("overleaf_view");
  });

  it("has no rebuttal slot: the venue ladder closes that one from a bcc now", () => {
    // It used to be a link somebody pasted, chased only while the venue had not decided. Keeping
    // both it and the `rebuttal` stage would give the card two accounts of the same fact.
    expect(adminBotPaperSlots as readonly string[]).not.toContain("rebuttal_doc");
  });

  it("ranks venue work above the rest when several are open at once", () => {
    const open = actionablePaperSlots(paper(), upTo("pdf_ready"), NOW);
    expect(open[0]?.slot).toBe("submission");
    expect(open.map((item) => item.slot)).toContain("slides");
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
    const old = paper({ created_at: "2020-01-01T00:00:00.000Z", dormant_override: true });
    expect(isPaperDormant(old, NOW)).toBe(false);
    expect(actionablePaperSlots(old, [], NOW)).toHaveLength(1);
  });
});

describe("the nudge ledger rules", () => {
  it("lets a never-nudged item through and holds a recently-nudged one", () => {
    expect(isNudgeDue(undefined, NOW, 3 * DAY)).toBe(true);
    expect(
      isNudgeDue(
        {
          domain: "paper_slot",
          subject_id: "p1:overleaf_edit",
          member_id: "ada",
          nudge_count: 1,
          last_nudged_at: new Date(NOW.getTime() - DAY).toISOString(),
        },
        NOW,
        3 * DAY,
      ),
    ).toBe(false);
  });

  it("skips a snoozed item until its clock runs out", () => {
    const entry = {
      domain: "paper_slot" as const,
      subject_id: "p1:poster",
      member_id: "ada",
      nudge_count: 0,
      snoozed_until: new Date(NOW.getTime() + DAY).toISOString(),
    };
    expect(isNudgeDue(entry, NOW, 3 * DAY)).toBe(false);
    expect(
      isNudgeDue(
        { ...entry, snoozed_until: new Date(NOW.getTime() - DAY).toISOString() },
        NOW,
        3 * DAY,
      ),
    ).toBe(true);
  });

  it("bounds a snooze", () => {
    expect(boundSnooze(new Date(NOW.getTime() + 60 * DAY).toISOString(), NOW)).toMatchObject({
      ok: false,
    });
    expect(boundSnooze(new Date(NOW.getTime() + 3 * DAY).toISOString(), NOW)).toMatchObject({
      ok: true,
    });
  });
});

describe("acceptance details and the conference branch", () => {
  it("stays shut until all four are recorded", () => {
    const accepted = paper({ venue_decision: "accept" });
    expect(isConferenceBranchOpen(accepted)).toBe(false);
    expect(missingAcceptanceDetails(accepted)).toEqual([
      "accepted venue",
      "year",
      "archival or not",
      "presentation type",
    ]);
    const complete = paper({
      venue_decision: "accept",
      accepted_venue: "ICLR 2027",
      accepted_year: 2027,
      is_archival: true,
      presentation_type: "oral",
    });
    expect(isConferenceBranchOpen(complete)).toBe(true);
    expect(missingAcceptanceDetails(complete)).toEqual([]);
  });

  it("asks for nothing on a paper the venue has not answered yet", () => {
    expect(missingAcceptanceDetails(paper())).toEqual([]);
  });

  it("treats a recorded false as answered -- non-archival is an answer", () => {
    const nonArchival = paper({
      venue_decision: "accept",
      accepted_venue: "workshop",
      accepted_year: 2027,
      is_archival: false,
      presentation_type: "poster",
    });
    expect(missingAcceptanceDetails(nonArchival)).toEqual([]);
  });
});

describe("isCycleClosed", () => {
  // The two social gates are derived, so "everything is in" needs real approved drafts rather than
  // slot rows claiming so -- which is the invariant working.
  const approvedDrafts: AdminBotSocialDraftRecord[] = [
    { id: "dx", paper_id: "p1", platform: "x", body: "x", generated_at: "", status: "approved" },
    {
      id: "dl",
      paper_id: "p1",
      platform: "linkedin",
      body: "li",
      generated_at: "",
      status: "approved",
    },
  ];
  const everything = () =>
    adminBotPaperSlots
      .filter(
        (slot) =>
          adminBotPaperSlotRegistry[slot].required && !adminBotPaperSlotRegistry[slot].derived,
      )
      .map((slot) => provided(slot));

  it("stays open while an artifact is outstanding", () => {
    expect(
      isCycleClosed({
        paper: paper(),
        slots: [],
        drafts: [],
        attendees: [],
        reimbursements: [],
      }),
    ).toBe(false);
  });

  it("closes when every artifact is in and nobody travelled", () => {
    expect(
      isCycleClosed({
        paper: paper(),
        slots: everything(),
        drafts: approvedDrafts,
        attendees: [],
        reimbursements: [],
      }),
    ).toBe(true);
  });

  it("is held open by one attending author who has not been reimbursed", () => {
    const attendees = [{ member_id: "ada", attending: "yes" }];
    expect(
      isCycleClosed({
        paper: paper(),
        slots: everything(),
        drafts: approvedDrafts,
        attendees,
        reimbursements: [{ paper_id: "p1", member_id: "ada", status: "pending" }],
      }),
    ).toBe(false);
    expect(
      isCycleClosed({
        paper: paper(),
        slots: everything(),
        drafts: approvedDrafts,
        attendees,
        reimbursements: [{ paper_id: "p1", member_id: "ada", status: "reimbursed" }],
      }),
    ).toBe(true);
  });

  it("is not held open by somebody who did not go, or by someone with no roster row", () => {
    expect(
      isCycleClosed({
        paper: paper(),
        slots: everything(),
        drafts: approvedDrafts,
        attendees: [{ member_id: "bob", attending: "no" }, { attending: "yes" }],
        reimbursements: [],
      }),
    ).toBe(true);
  });
});

describe("paperSlotProgress", () => {
  it("leaves the advisory slots out of the denominator, so the bar can reach the end", () => {
    const advisory = adminBotPaperSlots.filter(
      (slot) => !adminBotPaperSlotRegistry[slot].required,
    ).length;
    expect(paperSlotProgress("p1", []).total).toBe(adminBotPaperSlots.length - advisory);
  });
});

describe("resolveConsentAudience", () => {
  it("only names authors who are on the roster, and never the person circulating it", () => {
    const roster = [
      { id: "ada", name: "Ada Lovelace" },
      { id: "zj", name: "Zhijing Jin" },
    ];
    expect(
      resolveConsentAudience({
        authors: ["Ada Lovelace", "Zhijing Jin", "External Collaborator"],
        roster,
        exclude: "ada",
      }),
    ).toEqual(["zj"]);
  });
});

describe("draftConsentState", () => {
  it("approves only when nobody is pending and nobody wants changes", () => {
    const base = { draft_id: "d1", asked_at: NOW.toISOString() };
    expect(draftConsentState([]).approved).toBe(true);
    expect(draftConsentState([{ ...base, member_id: "a", decision: "ok" }]).approved).toBe(true);
    expect(draftConsentState([{ ...base, member_id: "a", decision: "pending" }]).approved).toBe(
      false,
    );
    expect(
      draftConsentState([{ ...base, member_id: "a", decision: "changes_requested" }]).approved,
    ).toBe(false);
  });
});

describe("buildNudgeMessage", () => {
  it("puts everything one person owes in one message, grouped by paper", () => {
    const message = buildNudgeMessage({
      groups: [
        {
          title: "Causal abstraction",
          deadline: "2026-08-27",
          items: actionablePaperSlots(paper(), [], NOW),
        },
        {
          title: "Second paper",
          items: actionablePaperSlots(paper({ id: "p2" }), [], NOW),
        },
      ],
      now: NOW,
    });
    expect(message).toContain("Causal abstraction");
    expect(message).toContain("Second paper");
    expect(message).toContain("Project folder or brainstorm doc");
    expect(message).toContain("deadline is in 7 days");
  });

  it("mentions a deadline only when the group carries one", () => {
    const message = buildNudgeMessage({
      groups: [{ title: "Causal abstraction", items: actionablePaperSlots(paper(), [], NOW) }],
      now: NOW,
    });
    expect(message).not.toContain("deadline");
  });

  it("never puts a credential in the text", () => {
    // The label is what travels, and a secret slot's label names the thing, not its value.
    const items = actionablePaperSlots(paper(), upTo("authors_ack"), NOW);
    const message = buildNudgeMessage({ groups: [{ title: "p", items }], now: NOW });
    expect(message).toContain("arXiv paper password");
    expect(message).not.toMatch(/[a-z]\d[a-z]\d[a-z]\d/u);
  });
});

describe("the refusal reason travels with the nudge", () => {
  it("appends why the value on file was rejected", () => {
    const invalid: AdminBotPaperSlotRecord = {
      paper_id: "p1",
      slot: "project_folder",
      status: "invalid",
      invalid_reason: "that is not a URL",
    };
    const items = actionablePaperSlots(paper(), [invalid], NOW);
    expect(items[0]?.detail).toContain("that is not a URL");
    const message = buildNudgeMessage({ groups: [{ title: "p", items }], now: NOW });
    // The author should not have to open the card to find out what was wrong with what they
    // already typed.
    expect(message).toContain("that is not a URL");
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
