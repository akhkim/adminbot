// Three asks with three audiences, and the split that decides which is which: the member keeps the
// date, only an admin can set the status.
import { describe, expect, it } from "vitest";
import {
  adminBotGraduationCeremonyMonth,
  adminBotGraduationConfirmLeadMonths,
  buildGraduationCeremonyMessage,
  buildGraduationConfirmMessage,
  buildGraduationTransitionMessage,
  graduationActions,
  graduationCeremony,
  type GraduationMember,
} from "./graduation.js";

const NOW = new Date("2026-06-15T09:00:00Z");
const member = (fields: Partial<GraduationMember> & { id: string }): GraduationMember => ({
  name: `Member ${fields.id}`,
  status: "active",
  ...fields,
});

describe("graduationActions", () => {
  it("asks the member to confirm once the month is inside the window", () => {
    expect(adminBotGraduationConfirmLeadMonths).toBe(2);
    expect(graduationActions([member({ id: "a", graduated_month: "2026-09" })], NOW)).toEqual([]);
    expect(graduationActions([member({ id: "a", graduated_month: "2026-08" })], NOW)).toEqual([
      expect.objectContaining({ kind: "confirm", months_until: 2 }),
    ]);
    // The month they are in counts: "this month" is exactly when the question is live.
    expect(graduationActions([member({ id: "a", graduated_month: "2026-06" })], NOW)).toEqual([
      expect.objectContaining({ kind: "confirm", months_until: 0 }),
    ]);
  });

  it("asks an admin once the month has passed", () => {
    expect(graduationActions([member({ id: "a", graduated_month: "2026-04" })], NOW)).toEqual([
      expect.objectContaining({ kind: "transition", months_since: 2 }),
    ]);
  });

  it("stops the moment somebody is actually alumni", () => {
    // The transition prompt exists to close the gap between the date passing and the status
    // catching up, so it has to stop when it has.
    expect(
      graduationActions([member({ id: "a", graduated_month: "2026-04", status: "alumni" })], NOW),
    ).toEqual([]);
  });

  it("says nothing about a member with no month, or a month that is not one", () => {
    expect(graduationActions([member({ id: "a" })], NOW)).toEqual([]);
    expect(graduationActions([member({ id: "a", graduated_month: "soon" })], NOW)).toEqual([]);
    expect(graduationActions([member({ id: "a", graduated_month: "2026-13" })], NOW)).toEqual([]);
  });
});

describe("graduationCeremony", () => {
  it("comes into view three months out, and not before", () => {
    expect(adminBotGraduationCeremonyMonth).toBe(6);
    const graduating = [member({ id: "a", graduated_month: "2026-06" })];
    // In February, June is four months away.
    expect(graduationCeremony(graduating, new Date("2026-02-15T00:00:00Z"))).toBeUndefined();
    expect(graduationCeremony(graduating, new Date("2026-03-15T00:00:00Z"))?.year).toBe(2026);
  });

  it("rolls to next year once this year's has been and gone", () => {
    const graduating = [
      member({ id: "a", graduated_month: "2026-06" }),
      member({ id: "b", graduated_month: "2027-05" }),
    ];
    // July 2026: this year's is past, and next year's is nine months out -- too far.
    expect(graduationCeremony(graduating, new Date("2026-07-15T00:00:00Z"))).toBeUndefined();
    const next = graduationCeremony(graduating, new Date("2027-04-15T00:00:00Z"));
    expect(next?.year).toBe(2027);
    expect(next?.graduates.map((graduate) => graduate.member_id)).toEqual(["b"]);
  });

  it("counts the year's graduates, including the ones who have already left", () => {
    // A ceremony is for the year's graduates; somebody who finished in March and is now alumni is
    // exactly who it is for.
    const ceremony = graduationCeremony(
      [
        member({ id: "gone", graduated_month: "2026-03", status: "alumni" }),
        member({ id: "soon", graduated_month: "2026-06" }),
      ],
      new Date("2026-04-15T00:00:00Z"),
    );
    expect(ceremony?.graduates.map((graduate) => graduate.member_id)).toEqual(["gone", "soon"]);
  });

  it("says nothing when nobody is graduating that year", () => {
    expect(
      graduationCeremony([member({ id: "a", graduated_month: "2028-06" })], NOW),
    ).toBeUndefined();
  });
});

describe("the messages", () => {
  it("tells the member the date is theirs and the status is not", () => {
    const message = buildGraduationConfirmMessage({ month: "2026-06", months_until: 0 });
    expect(message).toContain("finishing this month");
    expect(message).toContain("Wrapping up and moving on");
    expect(message).toContain("update the month on My Profile");
    // The one thing they must not go looking for a control to do.
    expect(message).toContain("An admin marks you as alumni");
  });

  it("gives the admins one list and both ways to clear it", () => {
    const message = buildGraduationTransitionMessage([
      { member_name: "Mei Chen", month: "2026-04", months_since: 2 },
      { member_name: "Ben Nevis", month: "2026-05", months_since: 1 },
    ]);
    expect(message).toContain("Mei Chen — 2026-04");
    expect(message).toContain("Ben Nevis");
    // Either they left or the date was wrong; the message says both, because a queue with one
    // exit is a queue people leave rows in.
    expect(message).toContain("Set them to alumni");
    expect(message).toContain("clear the month");
  });

  it("names the ceremony's graduates", () => {
    const message = buildGraduationCeremonyMessage({
      year: 2026,
      month: "2026-06",
      graduates: [{ member_id: "a", member_name: "Mei Chen", month: "2026-06" }],
    });
    expect(message).toContain("2026 graduation ceremony");
    expect(message).toContain("Mei Chen");
    expect(message).toContain("still reachable");
  });
});
