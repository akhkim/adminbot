import { render } from "lit";
import { describe, expect, it } from "vitest";
import { adminBotBadgeEmoji } from "../../../../../extensions/adminbot/src/contracts/badges.js";
import type { AssignedBadge } from "../auth/session.ts";
import { badgeCountLabel, renderMemberBadgeSymbols } from "./badge-symbols.ts";

describe("member badge symbols", () => {
  it("shows count next to an accessible emoji and supports legacy and custom badges", () => {
    const container = document.createElement("div");
    const badge = {
      name: "Referral Bonus",
      description: "Recommended a collaborator",
      count: 3,
    } as AssignedBadge;
    render(renderMemberBadgeSymbols([badge]), container);
    expect(container.textContent).toContain("🤝3");
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
      "Referral Bonus ×3",
    );
    expect(badgeCountLabel({ ...badge, count: undefined })).toBe("Referral Bonus ×1");
    expect(adminBotBadgeEmoji("New Award")).toBe("🏅");
  });
});
