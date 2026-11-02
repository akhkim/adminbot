import { describe, expect, it } from "vitest";
import { collaboratorChatReadiness } from "./chat-request.js";

const participant = (id: string) => ({
  member_id: id,
  slack_user_id: `U${id.toUpperCase()}`,
  verified_slack_user_id: `U${id.toUpperCase()}`,
});

describe("collaborator chat readiness", () => {
  it("does not confuse a stored or invited identity with verified membership", () => {
    expect(
      collaboratorChatReadiness([participant("a"), { member_id: "b", slack_user_id: "Ub" }]),
    ).toMatchObject({ ready: false, waiting_member_ids: ["b"] });
  });
  it("requires verification again after a linked identity changes", () => {
    expect(
      collaboratorChatReadiness([
        participant("a"),
        { ...participant("b"), slack_user_id: "Uchanged" },
      ]).ready,
    ).toBe(false);
  });
  it("accepts distinct verified participants", () => {
    expect(collaboratorChatReadiness([participant("a"), participant("b")])).toEqual({
      ready: true,
      slack_user_ids: ["UA", "UB"],
    });
  });
  it("rejects duplicates and invalid group sizes", () => {
    expect(collaboratorChatReadiness([participant("a"), participant("a")]).ready).toBe(false);
    expect(
      collaboratorChatReadiness([{ ...participant("a"), member_id: "b" }, participant("a")]).ready,
    ).toBe(false);
    expect(collaboratorChatReadiness([participant("a")]).ready).toBe(false);
    expect(
      collaboratorChatReadiness(Array.from({ length: 9 }, (_, i) => participant(String(i)))).ready,
    ).toBe(false);
  });
});
