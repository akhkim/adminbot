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
  it("shows compact follower counts without relabeling legacy Media Impact awards", () => {
    const container = document.createElement("div");
    const badge = {
      name: "Media Impact",
      follower_count: 10000,
      description: "Self-reported audience",
    } as AssignedBadge;
    render(renderMemberBadgeSymbols([badge]), container);
    expect(container.querySelector("small")?.textContent).toBe("10K");
    expect(badgeCountLabel(badge)).toBe("Media Impact · 10000 followers");
    expect(badgeCountLabel({ ...badge, follower_count: undefined, count: 10000 })).toBe(
      "Media Impact ×10000",
    );
  });
  it("shows each Causality level rather than its assignment count", () => {
    const container = document.createElement("div");
    for (const level of [1, 2, 3]) {
      const badge = {
        name: "Causality",
        tier: `Level ${level}`,
        count: 1,
        description: "Causal research",
      } as AssignedBadge;
      render(renderMemberBadgeSymbols([badge]), container);
      expect(container.querySelector("small")?.textContent).toBe(String(level));
      expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
        `Causality · Level ${level}`,
      );
    }
    const unrelated = { name: "Another badge", tier: "Level 3", count: 2 } as AssignedBadge;
    expect(badgeCountLabel(unrelated)).toBe("Another badge · Level 3 ×2");
  });
});
