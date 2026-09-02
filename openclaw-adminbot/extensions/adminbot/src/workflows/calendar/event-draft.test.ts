import { describe, expect, it, vi } from "vitest";
import { buildEventDraftPrompt, createEventDraftRunner, parseEventDraft } from "./event-draft.js";

describe("buildEventDraftPrompt", () => {
  // "1pm" has to mean the operator's 1pm. Without the zone in the prompt the model resolves it
  // against UTC and every event lands hours out.
  it("states the current time and the operator's timezone", () => {
    const prompt = buildEventDraftPrompt({
      prompt: "lunch with the reading group next Tuesday at 1",
      timezone: "America/Toronto",
      now: "2026-08-13T15:00:00.000Z",
    });
    expect(prompt).toContain("2026-08-13T15:00:00.000Z");
    expect(prompt).toContain("America/Toronto");
    expect(prompt).toContain("lunch with the reading group next Tuesday at 1");
  });

  it("falls back to UTC rather than leaving the zone unstated", () => {
    expect(buildEventDraftPrompt({ prompt: "standup tomorrow" })).toContain("UTC");
  });
});

describe("buildEventDraftPrompt, editing an event", () => {
  const editing = {
    summary: "Lab retreat planning",
    start: "2026-09-01T13:00",
    end: "2026-09-01T14:00",
    location: "DCS lounge",
  };

  it("tells the model what the event currently says", () => {
    const prompt = buildEventDraftPrompt({
      prompt: "move it to Thursday at 3",
      timezone: "America/Toronto",
      editing,
    });
    expect(prompt).toContain("already exists");
    expect(prompt).toContain("Lab retreat planning");
    expect(prompt).toContain("2026-09-01T13:00");
    expect(prompt).toContain("DCS lounge");
  });

  // The update writes what it is given, so a model that returns `{start, end}` alone would blank
  // the title and the location. The prompt has to ask for the whole event back.
  it("asks for every field back, not just the changed ones", () => {
    const prompt = buildEventDraftPrompt({ prompt: "move it to Thursday", editing });
    expect(prompt).toContain("every field");
    expect(prompt).toContain("Change only what it asks for");
  });

  it("names a field the event has not set rather than omitting the line", () => {
    const prompt = buildEventDraftPrompt({
      prompt: "add the zoom link",
      editing: { summary: "Sync", start: "2026-09-01T13:00" },
    });
    expect(prompt).toContain("(not set)");
  });
});

describe("parseEventDraft", () => {
  const good = JSON.stringify({
    summary: "Reading group lunch",
    start: "2026-08-18T13:00",
    end: "2026-08-18T14:00",
    location: "DCS lounge",
  });

  it("reads a well-formed draft", () => {
    const result = parseEventDraft(good, "America/Toronto");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.draft.summary).toBe("Reading group lunch");
    expect(result.draft.location).toBe("DCS lounge");
    // The operator's zone rides along, so the proposal names the zone its times are in.
    expect(result.draft.timezone).toBe("America/Toronto");
  });

  it("does not let a model-invented display label override the trusted operator zone", () => {
    const result = parseEventDraft(
      JSON.stringify({
        summary: "Deadline check-in",
        start: "2026-08-18T13:00",
        end: "2026-08-18T14:00",
        timezone: "Anywhere on Earth (AoE, UTC−12)",
      }),
      "America/Toronto",
    );
    expect(result).toMatchObject({
      ok: true,
      draft: { timezone: "America/Toronto" },
    });
  });

  it("canonicalizes an operator-provided AoE display label", () => {
    const result = parseEventDraft(good, "Anywhere on Earth (AoE, UTC−12)");
    expect(result).toMatchObject({ ok: true, draft: { timezone: "Etc/GMT+12" } });
  });

  it("refuses an invalid operator timezone before returning a draft", () => {
    expect(parseEventDraft(good, "Toronto-ish")).toMatchObject({
      ok: false,
      error: expect.stringContaining("valid IANA"),
    });
  });

  // Models fence JSON even when told not to.
  it("reads a draft the model wrapped in prose or a code fence", () => {
    expect(parseEventDraft("Sure! ```json\n" + good + "\n```").ok).toBe(true);
  });

  it("accepts a zoned timestamp as well as a local one", () => {
    const zoned = JSON.stringify({
      summary: "Sync",
      start: "2026-08-18T13:00:00-04:00",
      end: "2026-08-18T14:00:00-04:00",
    });
    expect(parseEventDraft(zoned).ok).toBe(true);
  });

  it.each([
    ["prose with no object", "I can help with that!"],
    ["invalid JSON", "{ summary: 'Sync' "],
    ["no title", JSON.stringify({ start: "2026-08-18T13:00", end: "2026-08-18T14:00" })],
    ["no times", JSON.stringify({ summary: "Sync" })],
    [
      "an unusable time",
      JSON.stringify({ summary: "Sync", start: "next Tuesday", end: "2026-08-18T14:00" }),
    ],
    [
      "an end before the start",
      JSON.stringify({ summary: "Sync", start: "2026-08-18T15:00", end: "2026-08-18T14:00" }),
    ],
  ])("refuses %s with a reason", (_label, text) => {
    const result = parseEventDraft(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.length).toBeGreaterThan(0);
  });

  // A local time and a zoned one are never compared here, but two local times of different
  // lengths were: "13:00" against "13:00:00" compared shorter-is-smaller and passed a zero-length
  // event as valid.
  it("refuses a zero-length event written at two precisions", () => {
    const same = JSON.stringify({
      summary: "Sync",
      start: "2026-08-18T13:00",
      end: "2026-08-18T13:00:00",
    });
    expect(parseEventDraft(same).ok).toBe(false);
  });

  it("keeps only the attendees that look like addresses", () => {
    const withAttendees = JSON.stringify({
      summary: "Sync",
      start: "2026-08-18T13:00",
      end: "2026-08-18T14:00",
      attendees: ["ada@cs.toronto.edu", "the reading group", 42],
    });
    const result = parseEventDraft(withAttendees);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.draft.attendees).toEqual(["ada@cs.toronto.edu"]);
  });
});

describe("createEventDraftRunner", () => {
  it("drafts through the broker and returns the parsed event", async () => {
    const handle = vi.fn().mockResolvedValue({
      route: "local",
      output: JSON.stringify({
        summary: "Sync",
        start: "2026-08-18T13:00",
        end: "2026-08-18T14:00",
      }),
    });
    const run = createEventDraftRunner(handle);
    const result = await run({ prompt: "sync tuesday at 1", timezone: "America/Toronto" });
    expect(result.ok).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0][0].task).toContain("sync tuesday at 1");
  });

  it("does not spend a model call on an empty prompt", async () => {
    const handle = vi.fn();
    const result = await createEventDraftRunner(handle)({ prompt: "   " });
    expect(result.ok).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it("reports a model that answered with nothing", async () => {
    const handle = vi.fn().mockResolvedValue({ route: "local", output: "" });
    const result = await createEventDraftRunner(handle)({ prompt: "sync tuesday" });
    expect(result.ok).toBe(false);
  });
});
