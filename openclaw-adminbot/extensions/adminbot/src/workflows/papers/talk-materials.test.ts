// The post-submission talk reminders, tested without a store. All links are synthetic.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  ADMINBOT_QUICK_POINTERS_DOC_URL,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import type { NudgeItem } from "./paper-slots.js";
import {
  TALK_MATERIALS_WINDOW_DAYS,
  parseTalkMaterialsConfig,
  resolveTalkMaterials,
  resolveTalkTopic,
  talkMaterialReminders,
  talkSlidesDetail,
  withTalkSlidesDetail,
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

  it("keeps aliases, the lab-wide Quick Pointers doc and the deck list", () => {
    const config = parseTalkMaterialsConfig({
      quickpointers_url: "https://docs.example.test/pointers",
      decks_index_url: "http://docs.example.test/not-https",
      topics: { causality: { aliases: ["Causal", " ", 7] } },
    });
    expect(config).toEqual({
      quickpointers_url: "https://docs.example.test/pointers",
      topics: { causality: { aliases: ["causal"] } },
    });
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

  it("matches aliases, and tries the research topics after the branch", () => {
    const config = parseTalkMaterialsConfig({
      topics: { causality: { aliases: ["causal"] }, democracy: {} },
    });
    expect(resolveTalkTopic(config, "Causal AI")?.key).toBe("causality");
    expect(resolveTalkTopic(config, ["NLP", "AI for democracy"])?.key).toBe("democracy");
    expect(resolveTalkTopic(config, ["NLP", undefined])).toBeUndefined();
  });
});

describe("resolveTalkMaterials", () => {
  it("names the topic's deck and falls back to the lab's Quick Pointers doc", () => {
    const view = resolveTalkMaterials(
      parseTalkMaterialsConfig({
        topics: { causality: { mega_deck_url: "https://slides.example.test/c" } },
      }),
      "causality",
    );
    expect(view).toEqual({
      topic_key: "causality",
      topic_label: "causality",
      mega_deck_url: "https://slides.example.test/c",
      quickpointers_url: ADMINBOT_QUICK_POINTERS_DOC_URL,
      decks_index_url: ADMINBOT_QUICK_POINTERS_DOC_URL,
    });
  });

  it("points at the list of decks when no topic matches", () => {
    const config = parseTalkMaterialsConfig({
      quickpointers_url: "https://docs.example.test/pointers",
      decks_index_url: "https://drive.example.test/decks",
      topics: { causality: { mega_deck_url: "https://slides.example.test/c" } },
    });
    const view = resolveTalkMaterials(config, "robotics");
    expect(view.mega_deck_url).toBeUndefined();
    expect(view.decks_index_url).toBe("https://drive.example.test/decks");
    expect(talkSlidesDetail(view)).toContain("<https://drive.example.test/decks|list of decks>");
    expect(talkSlidesDetail(view)).toMatch(/never delete/u);
  });
});

describe("withTalkSlidesDetail", () => {
  const slides: NudgeItem = {
    domain: "paper_slot",
    subjectId: "p1:slides",
    owner: "first_author",
    label: "Talk slides",
    detail: "generic",
    priority: 1,
    deadlineBearing: false,
    slot: "slides",
  };

  it("names the author's own deck on the slides chase and leaves other items alone", () => {
    const view = resolveTalkMaterials(CONFIG, "democracy");
    expect(withTalkSlidesDetail(slides, view).detail).toContain(
      "<https://slides.example.test/democracy-deck|democracy mega deck>",
    );
    const poster = { ...slides, slot: "poster" as const, subjectId: "p1:poster" };
    expect(withTalkSlidesDetail(poster, view)).toBe(poster);
  });
});

describe("talkMaterialReminders", () => {
  it("says nothing before the paper is submitted or the slides are in", () => {
    expect(talkMaterialReminders({ paper: paper(), stored: [], now: NOW, config: CONFIG })).toEqual(
      [],
    );
  });

  it("asks for Quick Pointers once the first submission is in, and the deck once slides are", () => {
    const submitted = talkMaterialReminders({
      paper: paper(),
      stored: [row("submission", "provided")],
      now: NOW,
      config: CONFIG,
      researchBranch: "democracy",
    });
    // The slides chase names the deck until the slides are linked; one ask, not two.
    expect(submitted.map((item) => item.subjectId)).toEqual(["p1:talk_quickpointers"]);
    expect(submitted[0]?.label).toContain(
      "<https://docs.example.test/democracy-pointers|Quick Pointers>",
    );
    expect(submitted[0]?.label).toContain("under democracy");

    const items = talkMaterialReminders({
      paper: paper(),
      stored: [row("submission", "provided"), row("slides", "provided")],
      now: NOW,
      config: CONFIG,
      researchBranch: "democracy",
    });
    expect(items.map((item) => item.subjectId)).toEqual([
      "p1:talk_mega_deck",
      "p1:talk_quickpointers",
    ]);
    expect(items.every((item) => item.owner === "first_author")).toBe(true);
    expect(items[0]?.label).toContain(
      "<https://slides.example.test/democracy-deck|democracy mega deck>",
    );
    expect(items[0]?.detail).toMatch(/never delete/u);
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

  it("links the lab's Quick Pointers doc and the deck list when nothing is configured", () => {
    const items = talkMaterialReminders({
      paper: paper(),
      stored: [row("submission", "provided"), row("slides", "provided")],
      now: NOW,
      config: { topics: {} },
    });
    expect(items[0]?.label).toContain("mega deck");
    expect(items[0]?.label).toContain(`<${ADMINBOT_QUICK_POINTERS_DOC_URL}|list of decks>`);
    expect(items[1]?.label).toContain(`<${ADMINBOT_QUICK_POINTERS_DOC_URL}|Quick Pointers>`);
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
