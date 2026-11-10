// The post-submission talk reminders, tested without a store. All links are synthetic.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import type { AdminBotPaperSlot, AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import {
  TALK_MATERIALS_WINDOW_DAYS,
  parseTalkMaterialsConfig,
  resolveTalkTopic,
  talkMaterialReminders,
} from "./talk-materials.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const CONFIG = parseTalkMaterialsConfig(
  JSON.stringify({
    default_topic: "causality",
    topics: {
      causality: {
        label: "causality",
        mega_deck_url: "https://slides.example.test/causality-deck",
        quickpointers_url: "https://docs.example.test/causality-pointers",
      },
      Democracy: {
        mega_deck_url: "https://slides.example.test/democracy-deck",
        quickpointers_url: "https://docs.example.test/democracy-pointers",
      },
    },
  }),
);

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal abstraction",
    authors: ["Ada Lovelace"],
    current_step: "submission",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function row(
  slot: AdminBotPaperSlot,
  status: AdminBotPaperSlotRecord["status"],
  daysAgo = 2,
): AdminBotPaperSlotRecord {
  return {
    paper_id: "p1",
    slot,
    status,
    provided_at: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  };
}

describe("parseTalkMaterialsConfig", () => {
  it("fails soft on malformed JSON", () => {
    expect(parseTalkMaterialsConfig("{not json")).toEqual({ topics: {} });
    expect(parseTalkMaterialsConfig("")).toEqual({ topics: {} });
    expect(parseTalkMaterialsConfig("[]")).toEqual({ topics: {} });
  });

  it("drops links that are not https, and a default topic that does not exist", () => {
    const config = parseTalkMaterialsConfig({
      default_topic: "missing",
      topics: {
        causality: {
          mega_deck_url: "http://slides.example.test/deck",
          quickpointers_url: "javascript:alert(1)",
        },
      },
    });
    expect(config).toEqual({ topics: { causality: {} } });
  });

  it("lower-cases topic keys", () => {
    expect(Object.keys(CONFIG.topics).toSorted()).toEqual(["causality", "democracy"]);
  });
});

describe("resolveTalkTopic", () => {
  it("matches a research branch by key or by mention, and falls back to the default", () => {
    expect(resolveTalkTopic(CONFIG, "Democracy")?.key).toBe("democracy");
    expect(resolveTalkTopic(CONFIG, "AI and democracy")?.key).toBe("democracy");
    expect(resolveTalkTopic(CONFIG, "interpretability")?.key).toBe("causality");
    expect(resolveTalkTopic(CONFIG, undefined)?.key).toBe("causality");
    expect(resolveTalkTopic({ topics: {} }, "democracy")).toBeUndefined();
  });
});

describe("talkMaterialReminders", () => {
  it("says nothing before the paper is submitted or the slides are in", () => {
    expect(talkMaterialReminders({ paper: paper(), stored: [], now: NOW, config: CONFIG })).toEqual(
      [],
    );
  });

  it("asks for the mega deck and QuickPointers once the first submission is in", () => {
    const items = talkMaterialReminders({
      paper: paper(),
      stored: [row("submission", "provided")],
      now: NOW,
      config: CONFIG,
      researchBranch: "democracy",
    });
    expect(items.map((item) => item.subjectId)).toEqual([
      "p1:talk_mega_deck",
      "p1:talk_quickpointers",
    ]);
    expect(items.every((item) => item.owner === "first_author")).toBe(true);
    expect(items[0]?.label).toContain("https://slides.example.test/democracy-deck");
    expect(items[0]?.detail).toMatch(/never delete/u);
    expect(items[1]?.label).toContain("https://docs.example.test/democracy-pointers");
  });

  it("also fires when the slides slot is filled", () => {
    const items = talkMaterialReminders({
      paper: paper(),
      stored: [row("slides", "provided")],
      now: NOW,
      config: CONFIG,
    });
    expect(items).toHaveLength(2);
  });

  it("is worded without a link when none is configured, and never invents one", () => {
    const items = talkMaterialReminders({
      paper: paper(),
      stored: [row("submission", "provided")],
      now: NOW,
      config: { topics: {} },
    });
    expect(items.map((item) => item.label).join("\n")).not.toMatch(/https?:/u);
    expect(items[0]?.label).toContain("mega deck");
    expect(items[1]?.label).toContain("QuickPointers");
  });

  it("does not fire for an old submission, or for one the backfill waived", () => {
    const old = talkMaterialReminders({
      paper: paper(),
      stored: [row("submission", "provided", TALK_MATERIALS_WINDOW_DAYS + 1)],
      now: NOW,
      config: CONFIG,
    });
    const waived = talkMaterialReminders({
      paper: paper(),
      stored: [row("submission", "waived")],
      now: NOW,
      config: CONFIG,
    });
    expect(old).toEqual([]);
    expect(waived).toEqual([]);
  });

  it("drops the deck line when the paper has no talk", () => {
    const items = talkMaterialReminders({
      paper: paper(),
      stored: [row("submission", "provided"), row("slides", "waived")],
      now: NOW,
      config: CONFIG,
    });
    expect(items.map((item) => item.subjectId)).toEqual(["p1:talk_quickpointers"]);
  });

  it("stays quiet on a closed paper", () => {
    const items = talkMaterialReminders({
      paper: paper({ venue_decision: "reject" }),
      stored: [row("submission", "provided")],
      now: NOW,
      config: CONFIG,
    });
    expect(items).toEqual([]);
  });
});
