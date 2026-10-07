// Member-suggested badges: the half of the catalogue an admin did not write.
//
// Its own file rather than more of service.badges.test.ts, which already covers assignment,
// tiers and nominations -- the two features share a noun and nothing else. Nominating asks who
// should hold a badge the lab has; suggesting asks what badges the lab should have.
import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function labWithMember(id = "pat"): AdminBotService {
  const service = new AdminBotService();
  unwrap(service.upsertLabMember({ id, name: `Member ${id}`, privilege_level: "member" }));
  return service;
}

const SUGGESTION = {
  category: "Team Contributor",
  name: "Reviewer Rescue",
  description: "Turned around an emergency review for a lab paper inside 48 hours.",
  rationale: "Three people did this for the ICML batch and none of it is on anyone's record.",
};

describe("AdminBotService badge suggestions", () => {
  it("files a suggestion as pending and creates no badge", () => {
    const service = labWithMember();
    const before = unwrap(service.listBadgeDefinitions()).badges.length;

    const suggestion = unwrap(service.submitBadgeSuggestion("pat", SUGGESTION)).suggestion;

    expect(suggestion.status).toBe("pending");
    expect(suggestion.suggested_by).toBe("pat");
    expect(suggestion.suggested_by_name).toBe("Member pat");
    expect(suggestion.created_badge_id).toBeUndefined();
    // The whole point of the pending state: proposing lab vocabulary must not mint it.
    expect(unwrap(service.listBadgeDefinitions()).badges).toHaveLength(before);
  });

  it("adds the badge to the catalogue on approval, and links it back to the suggestion", () => {
    const service = labWithMember();
    const suggestion = unwrap(service.submitBadgeSuggestion("pat", SUGGESTION)).suggestion;

    const decided = unwrap(service.decideBadgeSuggestion(suggestion.id, "approved", "admin-1"));

    expect(decided.suggestion.status).toBe("approved");
    expect(decided.suggestion.decided_by).toBe("admin-1");
    expect(decided.badge?.name).toBe("Reviewer Rescue");
    expect(decided.suggestion.created_badge_id).toBe(decided.badge?.id);
    const catalogue = unwrap(service.listBadgeDefinitions()).badges;
    expect(catalogue.map((badge) => badge.name)).toContain("Reviewer Rescue");

    // And the approved badge is immediately nominable, which is the point of approving it.
    const nomination = unwrap(
      service.submitBadgeNomination("pat", {
        badge_id: decided.badge!.id,
        evidence: "Reviewed the ICML rebuttal overnight.",
      }),
    ).nomination;
    expect(nomination.badge_name).toBe("Reviewer Rescue");
  });

  it("records a rejection without touching the catalogue", () => {
    const service = labWithMember();
    const before = unwrap(service.listBadgeDefinitions()).badges.length;
    const suggestion = unwrap(service.submitBadgeSuggestion("pat", SUGGESTION)).suggestion;

    const decided = unwrap(service.decideBadgeSuggestion(suggestion.id, "rejected", "admin-1"));

    expect(decided.suggestion.status).toBe("rejected");
    expect(decided.badge).toBeUndefined();
    expect(decided.suggestion.created_badge_id).toBeUndefined();
    expect(unwrap(service.listBadgeDefinitions()).badges).toHaveLength(before);
    // The rationale survives the rejection: it is the record of what somebody thought was going
    // unrecognised, which outlives the answer.
    expect(decided.suggestion.rationale).toBe(SUGGESTION.rationale);
  });

  it("decides a suggestion exactly once", () => {
    const service = labWithMember();
    const suggestion = unwrap(service.submitBadgeSuggestion("pat", SUGGESTION)).suggestion;
    unwrap(service.decideBadgeSuggestion(suggestion.id, "approved", "admin-1"));

    expect(service.decideBadgeSuggestion(suggestion.id, "rejected", "admin-2")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses a badge the catalogue already has", () => {
    const service = labWithMember();

    const clash = service.submitBadgeSuggestion("pat", {
      category: "Team Contributor",
      name: "Bug Hunter",
      description: "Found a substantive error in a lab paper before submission.",
      rationale: "We should recognise this.",
    });

    expect(clash).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a second pending suggestion for the same badge", () => {
    const service = labWithMember();
    unwrap(service.upsertLabMember({ id: "sam", name: "Sam", privilege_level: "member" }));
    unwrap(service.submitBadgeSuggestion("pat", SUGGESTION));

    // Same badge, different member, and deliberately a different description -- the clash is the
    // badge's identity, not the wording.
    const second = service.submitBadgeSuggestion("sam", {
      ...SUGGESTION,
      description: "Did an emergency review.",
      rationale: "Same idea, filed separately.",
    });
    expect(second).toMatchObject({ ok: false, status: 409 });

    // Once it is decided the queue is clear again: a rejected idea can be raised a second time,
    // which is the difference between "already asked" and "already answered".
    const pending = unwrap(service.listBadgeSuggestions({ status: "pending" })).suggestions;
    unwrap(service.decideBadgeSuggestion(pending[0]!.id, "rejected", "admin-1"));
    expect(
      service.submitBadgeSuggestion("sam", { ...SUGGESTION, rationale: "Raising it again." }),
    ).toMatchObject({ ok: true });
  });

  it("validates the badge fields at submission, not at approval", () => {
    const service = labWithMember();

    expect(service.submitBadgeSuggestion("pat", { ...SUGGESTION, name: "" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(service.submitBadgeSuggestion("pat", { ...SUGGESTION, category: "" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      service.submitBadgeSuggestion("pat", { ...SUGGESTION, description: "Line one\nLine two" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      service.submitBadgeSuggestion("pat", { ...SUGGESTION, criteria_url: "javascript:alert(1)" }),
    ).toMatchObject({ ok: false, status: 400 });
    // Nothing reached the queue, so an admin never sees an item they cannot act on.
    expect(unwrap(service.listBadgeSuggestions()).suggestions).toEqual([]);
  });

  it("requires the rationale, which is the part an admin decides on", () => {
    const service = labWithMember();

    expect(service.submitBadgeSuggestion("pat", { ...SUGGESTION, rationale: "" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      service.submitBadgeSuggestion("pat", { ...SUGGESTION, rationale: "x".repeat(2001) }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a suggestion from somebody the roster does not know", () => {
    const service = new AdminBotService();

    expect(service.submitBadgeSuggestion("ghost", SUGGESTION)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("scopes the queue by suggester, which is what keeps a member out of everyone else's", () => {
    const service = labWithMember();
    unwrap(service.upsertLabMember({ id: "sam", name: "Sam", privilege_level: "member" }));
    unwrap(service.submitBadgeSuggestion("pat", SUGGESTION));
    unwrap(
      service.submitBadgeSuggestion("sam", {
        category: "Community Building",
        name: "Reading Group Host",
        description: "Ran the weekly reading group for a term.",
        rationale: "Somebody does this every term and it is invisible.",
      }),
    );

    const mine = unwrap(service.listBadgeSuggestions({ suggestedBy: "pat" })).suggestions;
    expect(mine.map((suggestion) => suggestion.name)).toEqual(["Reviewer Rescue"]);
    expect(unwrap(service.listBadgeSuggestions()).suggestions).toHaveLength(2);
  });

  it("refuses an approval that the catalogue has overtaken, and leaves it decidable", () => {
    const service = labWithMember();
    const suggestion = unwrap(service.submitBadgeSuggestion("pat", SUGGESTION)).suggestion;
    // An admin adds the same badge by hand while the suggestion sits in the queue.
    unwrap(
      service.createBadgeDefinition(
        {
          category: SUGGESTION.category,
          name: SUGGESTION.name,
          description: SUGGESTION.description,
        },
        "admin-1",
      ),
    );

    expect(service.decideBadgeSuggestion(suggestion.id, "approved", "admin-1")).toMatchObject({
      ok: false,
      status: 409,
    });
    // Still pending, so the admin can reject it deliberately rather than being left with a row
    // that cannot be cleared either way.
    const queued = unwrap(service.listBadgeSuggestions({ status: "pending" })).suggestions;
    expect(queued.map((entry) => entry.id)).toEqual([suggestion.id]);
    expect(service.decideBadgeSuggestion(suggestion.id, "rejected", "admin-1")).toMatchObject({
      ok: true,
    });
  });
});
