import { describe, expect, it } from "vitest";
import { nudgeIntervalMs, trimNudgeBatch } from "./nudge-policy.js";
import { buildNudgeMessage, type NudgeItem } from "./paper-slots.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-23T12:00:00Z");
const item = (label: string, priority: number, extra: Partial<NudgeItem> = {}): NudgeItem => ({
  domain: "paper_slot",
  subjectId: `p:${label}`,
  owner: "first_author",
  label,
  priority,
  deadlineBearing: false,
  ...extra,
});

describe("nudgeIntervalMs", () => {
  const base = 7 * DAY;
  it("keeps the base cadence for the first nudges", () => {
    expect(nudgeIntervalMs({ baseMs: base, nudgeCount: 1, deadlineBearing: false, now })).toBe(
      base,
    );
  });
  it("stretches repeated nudges when nothing is urgent", () => {
    expect(nudgeIntervalMs({ baseMs: base, nudgeCount: 3, deadlineBearing: false, now })).toBe(
      14 * DAY,
    );
  });
  it("stays at base for a close deadline", () => {
    expect(
      nudgeIntervalMs({
        baseMs: base,
        nudgeCount: 5,
        deadlineBearing: true,
        paperDeadline: "2026-11-30T00:00:00Z",
        now,
      }),
    ).toBe(base);
  });
});

describe("trimNudgeBatch", () => {
  it("shrinks a four-paper person to two papers of three items each", () => {
    const groups = new Map(
      ["A", "B", "C", "D"].map((t, i) => [
        t,
        {
          deadline: new Date(now.getTime() + (i + 1) * 10 * DAY).toISOString(),
          items: [item("overleaf", 1), item("authors", 2), item("poster", 3), item("video", 4)],
        },
      ]),
    );
    const trimmed = trimNudgeBatch(groups, now);
    expect([...trimmed.groups.keys()]).toEqual(["A", "B"]);
    expect(trimmed.groups.get("A")?.items).toHaveLength(3);
    expect(trimmed.groups.get("A")?.moreItems).toBe(1);
    expect(trimmed.groups.get("B")?.morePapers).toBe(2);
    expect(trimmed.omittedItems.map((i) => i.label)).toContain("video");
  });
  it("keeps the one-line profile group alongside the papers", () => {
    const groups = new Map<string, { items: NudgeItem[]; heading?: string }>([
      ["A", { items: [item("x", 1)] }],
      ["profile", { heading: "*Your profile*", items: [item("avail", 9)] }],
    ]);
    expect([...trimNudgeBatch(groups, now).groups.keys()]).toEqual(["A", "profile"]);
  });
});

describe("buildNudgeMessage brevity", () => {
  it("omits generic how-to on repeats and names what was cut", () => {
    const text = buildNudgeMessage({
      now,
      groups: [
        {
          title: "Paper A",
          items: [
            item("Link", 1, { detail: "how to", repeat: true }),
            item("Bad", 2, { detail: "refused", repeat: true, essentialDetail: true }),
          ],
          moreItems: 2,
          morePapers: 1,
        },
      ],
    });
    expect(text).not.toContain("how to");
    expect(text).toContain("refused");
    expect(text).toContain("…and 2 more");
    expect(text).toContain("1 other paper will come up next time.");
  });
});
