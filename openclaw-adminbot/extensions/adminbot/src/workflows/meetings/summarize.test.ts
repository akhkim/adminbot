import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import type { GuidebookFetch } from "../../guidebook/local-client.js";
import {
  buildSummaryPrompt,
  parseSummaryReply,
  resolveActionItemOwners,
  summarizeMeeting,
} from "./summarize.js";

function member(id: string, name: string): AdminBotLabMember {
  return {
    id,
    name,
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const ROSTER = [member("m-andrew", "Andrew Kim"), member("m-priya", "Priya Raman")];

function replyingWith(content: string): { fetchImpl: GuidebookFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: GuidebookFetch = vi.fn(async (input, init) => {
    calls.push(input);
    void init;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  });
  return { fetchImpl, calls };
}

describe("summarizeMeeting", () => {
  it("returns a summary with owners resolved to members", async () => {
    const { fetchImpl } = replyingWith(
      JSON.stringify({
        overview: "The group reviewed the EMNLP timeline.",
        decisions: ["Submit to EMNLP rather than ARR"],
        action_items: [
          { text: "Rerun the ablations", owner_name: "Priya Raman" },
          { text: "Book the retreat room", owner_name: "Someone Not On The Roster" },
        ],
      }),
    );
    const summary = await summarizeMeeting(
      {
        topic: "Weekly Lab Meeting",
        startedAt: "2026-08-12T14:00:00.000Z",
        transcriptText: "[00:00:03] Andrew Kim: let's start",
        members: ROSTER,
      },
      { fetchImpl, now: () => new Date("2026-08-12T16:00:00.000Z") },
    );
    expect(summary).toEqual({
      overview: "The group reviewed the EMNLP timeline.",
      decisions: ["Submit to EMNLP rather than ARR"],
      action_items: [
        { text: "Rerun the ablations", owner_name: "Priya Raman", owner_member_id: "m-priya" },
        { text: "Book the retreat room", owner_name: "Someone Not On The Roster" },
      ],
      generated_at: "2026-08-12T16:00:00.000Z",
      model: "nvidia/Qwen3.5-122B-A10B-NVFP4",
    });
  });

  // The guarantee the whole feature rests on: a transcript never leaves the machine. A base URL
  // pointing anywhere else must fail the call, not fall back to it.
  it("refuses to send a transcript to a non-loopback endpoint", async () => {
    const { fetchImpl, calls } = replyingWith("{}");
    await expect(
      summarizeMeeting(
        {
          topic: "Weekly",
          startedAt: "2026-08-12T14:00:00.000Z",
          transcriptText: "secret unpublished results",
          members: ROSTER,
        },
        { fetchImpl, baseUrl: "https://api.example.com/v1" },
      ),
    ).rejects.toThrow(/loopback/u);
    expect(calls).toEqual([]);
  });

  it("fails loudly rather than storing an empty summary", async () => {
    const { fetchImpl } = replyingWith("I'm sorry, I can't help with that.");
    await expect(
      summarizeMeeting(
        {
          topic: "Weekly",
          startedAt: "2026-08-12T14:00:00.000Z",
          transcriptText: "…",
          members: ROSTER,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow(/usable summary/u);
  });
});

describe("parseSummaryReply", () => {
  it("digs the object out of a fenced reply", () => {
    expect(
      parseSummaryReply('```json\n{"overview":"We met.","decisions":[],"action_items":[]}\n```'),
    ).toEqual({ overview: "We met.", decisions: [], actionItems: [] });
  });

  it("accepts a bare string action item", () => {
    expect(parseSummaryReply('{"overview":"x","action_items":["send the draft"]}')).toEqual({
      overview: "x",
      decisions: [],
      actionItems: [{ text: "send the draft" }],
    });
  });

  it("drops entries of the wrong shape instead of failing the whole summary", () => {
    expect(
      parseSummaryReply('{"overview":"x","decisions":[null,"real one",7],"action_items":[{}]}'),
    ).toEqual({ overview: "x", decisions: ["real one"], actionItems: [] });
  });

  it("is undefined for a reply with no overview", () => {
    expect(parseSummaryReply('{"decisions":["a"]}')).toBeUndefined();
    expect(parseSummaryReply("not json at all")).toBeUndefined();
  });
});

describe("resolveActionItemOwners", () => {
  it("leaves an ambiguous owner unresolved but still named", () => {
    const twins = [member("m-1", "Alex Chen"), member("m-2", "Alex Chen")];
    expect(resolveActionItemOwners([{ text: "do it", ownerName: "alex chen" }], twins)).toEqual([
      { text: "do it", owner_name: "alex chen" },
    ]);
  });
});

describe("buildSummaryPrompt", () => {
  it("truncates the middle of a runaway transcript, keeping both ends", () => {
    const prompt = buildSummaryPrompt({
      topic: "Marathon",
      startedAt: "2026-08-12T14:00:00.000Z",
      transcriptText: `START${"x".repeat(200_000)}END`,
      members: [],
    });
    expect(prompt).toContain("START");
    expect(prompt).toContain("END");
    expect(prompt).toContain("transcript truncated");
    expect(prompt.length).toBeLessThan(130_000);
  });
});
