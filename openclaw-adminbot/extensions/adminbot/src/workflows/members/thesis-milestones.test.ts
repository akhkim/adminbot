// What reads as a thesis, when each of the two messages is due, and why moving a date re-arms them.
import { describe, expect, it } from "vitest";
import {
  adminBotThesisGradingDelayDays,
  adminBotThesisGuidanceLeadDays,
  buildThesisGradingMessage,
  buildThesisGuidanceMessage,
  thesisLedgerSubject,
  thesisMilestoneActions,
  thesisMilestones,
  type ThesisMilestoneMember,
} from "./thesis-milestones.js";

const NOW = new Date("2026-06-01T09:00:00Z");
const onDay = (offset: number) => {
  const date = new Date(Date.UTC(2026, 5, 1 + offset));
  return date.toISOString().slice(0, 10);
};

function member(milestones: Array<{ date: string; label: string }>): ThesisMilestoneMember {
  return { id: "mei", name: "Mei Chen", status: "active", milestones };
}

describe("what counts as a thesis", () => {
  it("matches thesis and dissertation, in any casing, as a whole word", () => {
    const found = thesisMilestones([
      member([
        { date: onDay(1), label: "Thesis draft" },
        { date: onDay(2), label: "dissertation submission" },
        { date: onDay(3), label: "THESIS" },
      ]),
    ]);
    expect(found).toHaveLength(3);
  });

  it("leaves a defence alone", () => {
    // Nobody grades a thesis five days after the viva -- they grade it before -- so matching a
    // defence would remind the professor about work she has already done.
    expect(thesisMilestones([member([{ date: onDay(1), label: "Thesis defence" }])])).toHaveLength(
      1,
    );
    expect(thesisMilestones([member([{ date: onDay(1), label: "Defence" }])])).toEqual([]);
  });

  it("ignores milestones that are not thesis-shaped, and dates that are not dates", () => {
    expect(
      thesisMilestones([
        member([
          { date: onDay(1), label: "Conference travel" },
          { date: "next spring", label: "Thesis" },
        ]),
      ]),
    ).toEqual([]);
  });

  it("skips people the lab is no longer working with", () => {
    const gone: ThesisMilestoneMember = {
      id: "gone",
      name: "Gone",
      status: "alumni",
      milestones: [{ date: onDay(1), label: "Thesis" }],
    };
    expect(thesisMilestones([gone])).toEqual([]);
  });
});

describe("when each message is due", () => {
  const actionsOn = (offset: number) =>
    thesisMilestoneActions(
      thesisMilestones([member([{ date: onDay(offset), label: "Thesis" }])]),
      NOW,
    );

  it("says nothing until the date is inside the lead window", () => {
    expect(adminBotThesisGuidanceLeadDays).toBe(14);
    expect(actionsOn(15)).toEqual([]);
    expect(actionsOn(14)).toEqual([expect.objectContaining({ kind: "guidance", days_until: 14 })]);
  });

  it("keeps pointing at the guidebook right up to the day itself", () => {
    expect(actionsOn(0)).toEqual([expect.objectContaining({ kind: "guidance", days_until: 0 })]);
  });

  it("waits five days after the date before asking anyone to grade", () => {
    expect(adminBotThesisGradingDelayDays).toBe(5);
    expect(actionsOn(-1)).toEqual([]);
    expect(actionsOn(-4)).toEqual([]);
    expect(actionsOn(-5)).toEqual([expect.objectContaining({ kind: "grading", days_since: 5 })]);
  });

  it("stays open-ended on the late side, so a cron that missed a day still fires", () => {
    expect(actionsOn(-40)).toEqual([expect.objectContaining({ kind: "grading", days_since: 40 })]);
  });
});

describe("the ledger subject", () => {
  it("carries the date, so moving a thesis re-arms both messages", () => {
    const subjectFor = (offset: number) => {
      const [action] = thesisMilestoneActions(
        thesisMilestones([member([{ date: onDay(offset), label: "Thesis" }])]),
        NOW,
      );
      if (!action) {
        throw new Error(`expected an action ${offset} days out`);
      }
      return thesisLedgerSubject(action);
    };
    expect(subjectFor(3)).not.toBe(subjectFor(9));
    // ...and the two kinds never share a subject, or the grading reminder would be swallowed by
    // the guidance one having already been sent.
    expect(subjectFor(3)).toContain("guidance");
    expect(subjectFor(-9)).toContain("grading");
  });
});

describe("the messages", () => {
  it("tells the member when, points at the guidebook, and says the date can move", () => {
    const message = buildThesisGuidanceMessage({
      member_id: "mei",
      member_name: "Mei Chen",
      label: "Thesis draft",
      date: onDay(1),
      days_until: 1,
    });
    expect(message).toContain('"Thesis draft" milestone is tomorrow');
    expect(message).toContain("Submitting your thesis");
    expect(message).toContain("update it on Time Availability");
  });

  it("gives the professor one message naming everyone, not one each", () => {
    const message = buildThesisGradingMessage([
      {
        member_id: "mei",
        member_name: "Mei Chen",
        label: "Thesis",
        date: "2026-05-01",
        days_since: 6,
      },
      {
        member_id: "ben",
        member_name: "Ben Nevis",
        label: "Thesis",
        date: "2026-05-02",
        days_since: 5,
      },
    ]);
    expect(message).toContain("These thesis deadlines have passed");
    expect(message).toContain("Mei Chen");
    expect(message).toContain("Ben Nevis");
    expect(message).toContain("6 days ago");
  });
});
