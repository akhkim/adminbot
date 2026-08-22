// Who holds a paper's venue cycle, which stage it is waiting on, and what the mail says.
//
// Every case here is a rule that is easy to get subtly wrong and impossible to notice in
// production: the failure mode of all three is a message that does not get sent, and nobody
// reports mail they never received.
import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import type { AdminBotPaperflowEvidenceRecord } from "../../contracts/paperflow-stages.js";
import {
  isFullMember,
  matchesAuthorName,
  openPaperflowStage,
  paperflowRecipient,
  paperflowStageEmail,
} from "./paperflow-stages.js";

function member(
  overrides: Partial<AdminBotLabMember> & { id: string; name: string },
): AdminBotLabMember {
  return {
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as AdminBotLabMember;
}

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal Data Agent",
    authors: ["Maximilian Mordig", "Rahul Babu Shrestha", "Zhijing Jin"],
    current_step: "submission",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The paper is in front of a venue: the whole ladder is gated on this. */
function submitted(): AdminBotPaperSlotRecord[] {
  return [
    { paper_id: "p1", slot: "submission", status: "provided", url: "https://openreview.net/x" },
  ];
}

function evidence(
  ...stages: AdminBotPaperflowEvidenceRecord["stage"][]
): AdminBotPaperflowEvidenceRecord[] {
  return stages.map((stage) => ({
    paper_id: "p1",
    stage,
    recorded_at: "2026-07-01T00:00:00.000Z",
    recorded_by: "email_bcc" as const,
  }));
}

const now = new Date("2026-08-21T12:00:00.000Z");

describe("isFullMember", () => {
  it("takes members and admins", () => {
    expect(isFullMember(member({ id: "a", name: "A" }))).toBe(true);
    expect(isFullMember(member({ id: "b", name: "B", privilege_level: "admin" }))).toBe(true);
  });

  it("refuses trial and external collaborators, who are not ours to hand a hard clock to", () => {
    expect(isFullMember(member({ id: "c", name: "C", privilege_level: "trial" }))).toBe(false);
    expect(
      isFullMember(member({ id: "d", name: "D", privilege_level: "external_collaborator" })),
    ).toBe(false);
  });

  it("refuses alumni even though the privilege level survived them leaving", () => {
    expect(isFullMember(member({ id: "e", name: "E", status: "alumni" }))).toBe(false);
  });
});

describe("matchesAuthorName", () => {
  it("matches across a middle name the other spelling drops", () => {
    // The live case this exists for: the roster says "Rahul Shrestha", every paper says
    // "Rahul Babu Shrestha", and exact equality routes all of them to nobody.
    expect(matchesAuthorName("Rahul Shrestha", "Rahul Babu Shrestha")).toBe(true);
    expect(matchesAuthorName("Rahul Babu Shrestha", "Rahul Shrestha")).toBe(true);
  });

  it("ignores case, accents and punctuation", () => {
    expect(matchesAuthorName("Bernhard Schölkopf", "bernhard scholkopf")).toBe(true);
  });

  it("refuses two different people who merely share a surname", () => {
    expect(matchesAuthorName("Rahul Shrestha", "Priya Shrestha")).toBe(false);
  });

  it("refuses a shared first name with a different surname", () => {
    expect(matchesAuthorName("Rahul Shrestha", "Rahul Gupta")).toBe(false);
  });

  it("will not guess from a single-token name", () => {
    // "Jin" alone says too little; a loose match here would attach a paper to the wrong person.
    expect(matchesAuthorName("Jin", "Zhijing Jin")).toBe(false);
  });
});

describe("paperflowRecipient", () => {
  const roster = [
    member({ id: "max", name: "Maximilian Mordig", privilege_level: "external_collaborator" }),
    // Spelled as the roster spells it, which is not how the papers spell it.
    member({ id: "rahul", name: "Rahul Shrestha" }),
    member({ id: "zhijing", name: "Zhijing Jin", privilege_level: "admin" }),
  ];

  it("finds a member whose roster name omits the middle name the paper uses", () => {
    expect(paperflowRecipient(paper(), roster)?.member.id).toBe("rahul");
  });

  it("walks the author list in order and skips authors who are not full members", () => {
    const picked = paperflowRecipient(paper(), roster);
    // Maximilian is first on the paper but an external collaborator, so the responsibility falls
    // to the first person actually inside the lab.
    expect(picked?.member.id).toBe("rahul");
    expect(picked?.authorIndex).toBe(1);
    expect(picked?.prioritized).toBe(false);
  });

  it("takes the priority member ahead of an earlier author when configured", () => {
    const later = paper({ authors: ["Zhijing Jin", "Rahul Babu Shrestha"] });
    const picked = paperflowRecipient(later, roster, "rahul");
    expect(picked?.member.id).toBe("rahul");
    expect(picked?.prioritized).toBe(true);
  });

  it("does not report a priority pick as prioritized when they were already first anyway", () => {
    expect(paperflowRecipient(paper(), roster, "rahul")?.prioritized).toBe(false);
  });

  it("ignores a priority member who is not on this paper", () => {
    const other = paper({ authors: ["Zhijing Jin"] });
    expect(paperflowRecipient(other, roster, "rahul")?.member.id).toBe("zhijing");
  });

  it("has nobody when every author is outside the lab", () => {
    const outside = paper({ authors: ["Someone Else", "Maximilian Mordig"] });
    expect(paperflowRecipient(outside, roster)).toBeUndefined();
  });
});

describe("openPaperflowStage", () => {
  it("asks nothing before the paper is in front of a venue", () => {
    expect(openPaperflowStage({ paper: paper(), slots: [], evidence: [], now })).toBeUndefined();
  });

  it("asks about reviews first on a submitted paper", () => {
    const open = openPaperflowStage({ paper: paper(), slots: submitted(), evidence: [], now });
    expect(open?.stage).toBe("reviews_out");
  });

  it("moves to the rebuttal window once the review mail has been seen", () => {
    const open = openPaperflowStage({
      paper: paper(),
      slots: submitted(),
      evidence: evidence("reviews_out"),
      now,
    });
    expect(open?.stage).toBe("rebuttal");
    expect(open?.deadlineBearing).toBe(true);
  });

  it("moves to the decision once the rebuttal window has been accounted for", () => {
    const open = openPaperflowStage({
      paper: paper(),
      slots: submitted(),
      evidence: evidence("reviews_out", "rebuttal"),
      now,
    });
    expect(open?.stage).toBe("decision");
  });

  it("asks only one thing at a time, so a paper is never chased about two stages at once", () => {
    const open = openPaperflowStage({ paper: paper(), slots: submitted(), evidence: [], now });
    // The shape of the return is the guarantee: one stage or none, never a list.
    expect(open).toMatchObject({ stage: "reviews_out" });
  });

  it("stops asking about reviews and rebuttals once a decision is recorded by any route", () => {
    // An admin recording an accept has told us the decision came out. Chasing a closed past is
    // the fastest way to teach people these mails are not worth reading.
    const open = openPaperflowStage({
      paper: paper({ venue_decision: "accept" }),
      slots: submitted(),
      evidence: [],
      now,
    });
    expect(open?.stage).toBe("camera_ready");
  });

  it("ends the cycle on a reject", () => {
    expect(
      openPaperflowStage({
        paper: paper({ venue_decision: "reject" }),
        slots: submitted(),
        evidence: [],
        now,
      }),
    ).toBeUndefined();
  });

  it("walks the accept path from camera ready to conference travel", () => {
    const open = openPaperflowStage({
      paper: paper({ venue_decision: "accept" }),
      slots: submitted(),
      evidence: evidence("camera_ready"),
      now,
    });
    expect(open?.stage).toBe("conference");
  });

  it("goes quiet once every stage has been evidenced", () => {
    expect(
      openPaperflowStage({
        paper: paper({ venue_decision: "accept" }),
        slots: submitted(),
        evidence: evidence("camera_ready", "conference"),
        now,
      }),
    ).toBeUndefined();
  });

  it("leaves a dormant paper alone: it is resting, not late", () => {
    expect(
      openPaperflowStage({
        paper: paper({ created_at: "2023-01-01T00:00:00.000Z" }),
        slots: submitted(),
        evidence: [],
        now,
      }),
    ).toBeUndefined();
  });
});

describe("paperflowStageEmail", () => {
  const recipient = {
    member: member({ id: "rahul", name: "Rahul Babu Shrestha" }),
    authorIndex: 1,
    prioritized: false,
  };

  it("names the mailbox to bcc, which is the entire payload of the message", () => {
    const mail = paperflowStageEmail({
      paper: paper({ venue: "ARR" }),
      stage: "reviews_out",
      recipient,
      botEmail: "adminbot@example.org",
    });
    expect(mail.subject).toBe("Reviews: Causal Data Agent");
    expect(mail.body).toContain("adminbot@example.org");
    expect(mail.body).toContain("Have the reviews come back yet?");
    expect(mail.body).toContain("ARR");
  });

  it("explains why this person got it when they are not the listed first author", () => {
    const mail = paperflowStageEmail({
      paper: paper(),
      stage: "decision",
      recipient,
      botEmail: "adminbot@example.org",
    });
    expect(mail.body).toContain("first lab member on the author list");
  });

  it("says nothing about author order when the recipient is simply first", () => {
    const mail = paperflowStageEmail({
      paper: paper(),
      stage: "decision",
      recipient: { ...recipient, authorIndex: 0 },
      botEmail: "adminbot@example.org",
    });
    expect(mail.body).not.toContain("first lab member on the author list");
  });

  it("admits how many times it has asked, and offers the way out", () => {
    const mail = paperflowStageEmail({
      paper: paper(),
      stage: "reviews_out",
      recipient,
      botEmail: "adminbot@example.org",
      entry: {
        domain: "paperflow_stage",
        subject_id: "p1:reviews_out",
        member_id: "rahul",
        nudge_count: 3,
      },
    });
    expect(mail.body).toContain("Asked 3 times before");
  });
});
