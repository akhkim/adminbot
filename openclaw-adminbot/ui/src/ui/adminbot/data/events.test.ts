/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredMemberSession, saveStoredMemberSession } from "../auth/session.ts";
import { setEventGoing, type EventCard } from "./events.ts";

const CARD: EventCard = {
  key: "synthconf:2026",
  group_key: "synthconf:2026",
  label: "SynthConf 2026",
  status: "upcoming",
  going: [],
  on_paper: false,
  i_am_going: false,
  can_rsvp: true,
  near_you: false,
};

beforeEach(() => {
  saveStoredMemberSession({ sessionToken: "session-ada", expiresAt: "2099-01-01T00:00:00Z" });
});

afterEach(() => {
  clearStoredMemberSession();
  vi.restoreAllMocks();
});

describe("setEventGoing", () => {
  it("uses the Travel RSVP route and keeps an existing detailed answer", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ trip: {} }), { status: 200 }));
    await setEventGoing(
      "http://adminbot.test",
      {
        ...CARD,
        my_rsvp: {
          member_id: "ada",
          conference_key: "synthconf:2026",
          intent: "undecided",
          funding: "partial",
          needs_lodging: true,
          needs_visa_letter: true,
          arrival_on: "2026-10-13",
          notes: "late flight",
        } as EventCard["my_rsvp"],
      },
      true,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://adminbot.test/travel/conferences/synthconf%3A2026/rsvp");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      intent: "going",
      funding: "partial",
      needs_lodging: true,
      needs_visa_letter: true,
      arrival_on: "2026-10-13",
      notes: "late flight",
    });
  });

  it("withdraws on Not going", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ withdrawn: true }), { status: 200 }));
    await setEventGoing("http://adminbot.test", CARD, false);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});
