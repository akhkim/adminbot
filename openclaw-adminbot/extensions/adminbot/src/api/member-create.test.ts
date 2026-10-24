import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../contracts/actions.js";
import { normalizeMemberProfileValues } from "../contracts/member-profile-values.js";
import { newMemberIdentity } from "./member-create.js";

describe("onboarding identity and exact aliases", () => {
  it("handles diacritics, non-Latin names, and successive same-name collisions", () => {
    const rows = ["jose-doe", "jose-doe-2026", "jose-doe-2026-2"].map(
      (id) => ({ id }) as AdminBotLabMember,
    );
    expect(newMemberIdentity({ name: "José Doe" }, rows, new Date("2026-01-01"))).toEqual({
      id: "jose-doe-2026-3",
    });
    expect(newMemberIdentity({ name: "张伟" }, [], new Date("2026-01-01"))).toEqual({
      id: "member",
    });
  });
  it("normalizes only exact city/institution aliases without guessing custom values", () => {
    expect(normalizeMemberProfileValues({ location: " Tuebingen ", affiliation: "ETH" })).toEqual({
      location: "Tübingen",
      affiliation: "ETH Zurich",
    });
    expect(
      normalizeMemberProfileValues({
        location: "Zurich/Toronto",
        affiliation: "ETH collaboration",
      }),
    ).toEqual({ location: "Zurich/Toronto", affiliation: "ETH collaboration" });
  });
});
