import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../contracts/actions.js";
import {
  composeScheduledChangeNotice,
  scheduledChangeRemovesActiveAccess,
} from "./server.scheduled-change-notice.js";

const member = (fields: Partial<AdminBotLabMember>) =>
  ({ id: "m", name: "Aly Example", email: "m@lab.test", ...fields }) as AdminBotLabMember;

describe("composeScheduledChangeNotice", () => {
  it("names the new type, the day and the grace left", () => {
    const text = composeScheduledChangeNotice(
      member({}),
      { member_type: "acquaintance", due_on: "2026-11-25" },
      "2026-11-19",
    );
    expect(text.startsWith("Dear Aly,")).toBe(true);
    expect(text).toContain("to *Acquaintance* on *25 November 2026*");
    expect(text).toContain("This notice gives you 6 days before the change takes effect.");
    expect(text).toContain("#jinesis-active and #random-active");
    expect(text.endsWith("Jinesis Lab Administration (sent via AdminBot)")).toBe(true);
  });

  it("says tomorrow and today rather than one day or zero days", () => {
    const change = { member_type: "alumni", due_on: "2026-11-20" };
    expect(composeScheduledChangeNotice(member({}), change, "2026-11-19")).toContain(
      "This change takes effect tomorrow.",
    );
    expect(composeScheduledChangeNotice(member({}), change, "2026-11-20")).toContain(
      "This change takes effect today.",
    );
  });
});

describe("scheduledChangeRemovesActiveAccess", () => {
  it("is true for a coauthor leaving, even with their old subgroup still stored", () => {
    const cora = member({
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_major",
      member_type: "coauthor-major",
    });
    expect(scheduledChangeRemovesActiveAccess(cora, "acquaintance")).toBe(true);
  });

  it("is false for a move that keeps the active channels, or someone already outside them", () => {
    const full = member({ privilege_level: "member", member_type: "full" });
    expect(scheduledChangeRemovesActiveAccess(full, "coauthor-major")).toBe(false);
    const outside = member({
      privilege_level: "external_collaborator",
      member_type: "acquaintance",
    });
    expect(scheduledChangeRemovesActiveAccess(outside, "mailing-list")).toBe(false);
  });
});
