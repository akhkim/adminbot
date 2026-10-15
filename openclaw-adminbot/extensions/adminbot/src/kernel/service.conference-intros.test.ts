// Conference intros at the service boundary: when the three-person group DM goes out, who is in
// it, what it says, and that it goes out once.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const PEOPLE = [
  { id: "ada", name: "Ada Lovelace", slack: "UADA", topics: ["Multi-agent systems", "Causal LLM"] },
  { id: "bob", name: "Bob Babbage", slack: "UBOB", topics: ["Multi-Agent negotiation"] },
  { id: "cy", name: "Cy Hopper", slack: "UCY", topics: ["Causal inference"] },
  { id: "dee", name: "Dee Noether", slack: "UDEE", topics: ["Sparse autoencoders"] },
  { id: "eve", name: "Eve Unlinked", slack: undefined, topics: ["Multi-agent systems"] },
] as const;

function lab(execute: (proposal: AdminBotStoredProposal) => Promise<{ handled: boolean }>) {
  const service = new AdminBotService(undefined, {
    executor: { execute },
    now: () => new Date("2026-10-15T12:00:00Z"),
  });
  for (const person of PEOPLE) {
    unwrap(
      service.upsertLabMember({
        id: person.id,
        name: person.name,
        privilege_level: "member",
        member_type: "full",
        research_topics: [...person.topics],
        ...(person.slack ? { slack_user_id: person.slack } : {}),
      } as never),
    );
  }
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: "Synthetic",
      authors: PEOPLE.map((person) => person.name),
      author_links: PEOPLE.map((person) => ({ name: person.name, member_id: person.id })),
      current_step: "overleaf_writing",
      first_author_member_id: "ada",
      venue_decision: "accept",
      accepted_venue: "EMNLP",
      accepted_year: 2026,
      is_archival: true,
      presentation_type: "poster",
    }),
  );
  const going = (id: string, attending: "yes" | "no" = "yes") =>
    unwrap(
      service.setConferenceAttendee({
        paperId: "p1",
        name: PEOPLE.find((person) => person.id === id)!.name,
        memberId: id,
        attending,
        actorId: "ada",
        privileged: true,
      }),
    );
  return { service, going };
}

function intros(deliveries: AdminBotStoredProposal[]) {
  return deliveries.filter((proposal) => proposal.type === "slack.conference_intro");
}

describe("conference intros", () => {
  it("waits for three, introduces the first trio once, then the next arrival to their two closest", async () => {
    const deliveries: AdminBotStoredProposal[] = [];
    const { service, going } = lab(async (proposal) => {
      deliveries.push(proposal);
      return { handled: true };
    });
    going("ada");
    going("bob");
    going("eve"); // Going but not on Slack: cannot be in a group DM.
    const key = unwrap(service.listConferenceRosters()).conferences[0].key;
    // Two reachable people are a DM, not an introduction.
    expect(unwrap(await service.introduceConferenceAttendees(key)).introduced).toBe(0);
    expect(intros(deliveries)).toHaveLength(0);

    going("cy");
    await vi.waitFor(() => expect(intros(deliveries)).toHaveLength(1));
    const first = intros(deliveries)[0];
    const payload = first.proposed_payload as { user_ids: string[]; member_ids: string[] };
    expect(new Set(payload.member_ids)).toEqual(new Set(["ada", "bob", "cy"]));
    expect(payload.user_ids).toHaveLength(3);
    expect(first.risk_tier).toBe("T1");
    expect(first.idempotency_key).toMatch(/^conference-intro:/u);

    const message = (first.proposed_payload as { message: string }).message;
    expect(message).toContain("EMNLP 2026");
    expect(message).toContain("Where: Budapest, Hungary - https://www.google.com/maps/search/");
    expect(message).toMatch(/When: Sat, Oct 24 - Thu, Oct 29 \(in 9 days\)/u);
    expect(message).toMatch(/Event page: https:\/\/2026\.emnlp\.org/u);

    // Dee shares no theme with anyone: one partner is the seeded wildcard, said as such.
    going("dee");
    await vi.waitFor(() => expect(intros(deliveries)).toHaveLength(2));
    const second = intros(deliveries)[1];
    const secondPayload = second.proposed_payload as { member_ids: string[]; message: string };
    expect(secondPayload.member_ids[0]).toBe("dee");
    expect(secondPayload.member_ids).toHaveLength(3);
    expect(secondPayload.message).toContain("picked at random");

    // Running it again -- a re-save, the admin button -- sends nothing new.
    expect(unwrap(await service.introduceConferenceAttendees(key))).toEqual({
      introduced: 0,
      skipped: 4,
      deferred: 0,
      failed: 0,
    });
    expect(intros(deliveries)).toHaveLength(2);
    expect((await service.introduceConferenceAttendees("missing:2026")).ok).toBe(false);
  });

  it("picks the closest research overlap first, then a labelled wildcard", async () => {
    const deliveries: AdminBotStoredProposal[] = [];
    const { going } = lab(async (proposal) => {
      deliveries.push(proposal);
      return { handled: true };
    });
    going("dee");
    going("bob");
    going("cy");
    await vi.waitFor(() => expect(intros(deliveries)).toHaveLength(1));
    going("ada");
    await vi.waitFor(() => expect(intros(deliveries)).toHaveLength(2));
    const { member_ids, message } = intros(deliveries)[1].proposed_payload as {
      member_ids: string[];
      message: string;
    };
    // Ada shares multi-agent with Bob and causal with Cy; Dee shares nothing. The best match is one
    // of Bob or Cy, and the wildcard is drawn from whoever is left.
    expect(member_ids).toEqual(["ada", expect.any(String), expect.any(String)]);
    expect(["bob", "cy"]).toContain(member_ids[1]);
    expect(message).toMatch(/also works on (Multi-agent|Causal)/u);
    expect(message).toContain("is this round's wildcard");
  });

  it("retries a failed delivery without a duplicate once Slack is back", async () => {
    let down = true;
    const attempts: AdminBotStoredProposal[] = [];
    const { service, going } = lab(async (proposal) => {
      if (proposal.type !== "slack.conference_intro") return { handled: true };
      attempts.push(proposal);
      if (down) throw new Error("Slack unavailable");
      return { handled: true };
    });
    going("ada");
    going("bob");
    going("cy");
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(0));
    const key = unwrap(service.listConferenceRosters()).conferences[0].key;
    expect(unwrap(await service.introduceConferenceAttendees(key)).failed).toBeGreaterThan(0);
    down = false;
    expect(unwrap(await service.introduceConferenceAttendees(key)).introduced).toBe(1);
    const sentBefore = attempts.length;
    expect(unwrap(await service.introduceConferenceAttendees(key)).introduced).toBe(0);
    expect(attempts).toHaveLength(sentBefore);
  });

  it("does not resend an intro an admin rejected", async () => {
    const attempts: AdminBotStoredProposal[] = [];
    const { service, going } = lab(async (proposal) => {
      if (proposal.type !== "slack.conference_intro") return { handled: true };
      attempts.push(proposal);
      throw new Error("Slack unavailable");
    });
    going("ada");
    going("bob");
    going("cy");
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(0));
    const key = unwrap(service.listConferenceRosters()).conferences[0].key;
    // Let every in-flight attempt settle, then reject what is left unexecuted.
    await service.introduceConferenceAttendees(key);
    const pending = [...new Set(attempts.map((proposal) => proposal.id))]
      .map((id) => service.getProposal(id))
      .filter((proposal) => proposal?.status === "approved" || proposal?.status === "pending");
    // One per subject: nobody is covered while every delivery fails.
    expect(pending).toHaveLength(3);
    for (const proposal of pending) unwrap(service.removePending(proposal!.id, { note: "no" }));
    const before = attempts.length;
    expect(unwrap(await service.introduceConferenceAttendees(key))).toEqual({
      introduced: 0,
      skipped: 3,
      deferred: 0,
      failed: 0,
    });
    expect(attempts).toHaveLength(before);
  });
});
