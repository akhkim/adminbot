import { html } from "lit";
import { adminBotBadgeEmoji } from "../../../../../extensions/adminbot/src/contracts/badges.js";
import type { AssignedBadge } from "../auth/session.ts";

function causalityLevel(badge: Pick<AssignedBadge, "name" | "tier">): string | undefined {
  return badge.name === "Causality" ? /^Level ([123])$/u.exec(badge.tier ?? "")?.[1] : undefined;
}

function followerCount(badge: Pick<AssignedBadge, "name" | "follower_count">): string | undefined {
  if (
    badge.name !== "Media Impact" ||
    !Number.isSafeInteger(badge.follower_count) ||
    (badge.follower_count ?? 0) <= 1000
  ) {
    return undefined;
  }
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    badge.follower_count!,
  );
}

export function badgeCountLabel(
  badge: Pick<AssignedBadge, "name" | "tier" | "count" | "follower_count">,
): string {
  const label = badge.tier ? `${badge.name} · ${badge.tier}` : badge.name;
  return followerCount(badge)
    ? `${label} · ${badge.follower_count} followers`
    : causalityLevel(badge)
      ? label
      : `${label} ×${badge.count ?? 1}`;
}

export function renderMemberBadgeSymbols(badges: readonly AssignedBadge[] = []) {
  return html`<span class="adminbot-member-badge-symbols"
    >${badges.map(
      (badge) => html` <span
        tabindex="0"
        title=${`${badgeCountLabel(badge)} — ${badge.description}`}
        aria-label=${badgeCountLabel(badge)}
      >
        ${adminBotBadgeEmoji(badge.name)}<small
          >${followerCount(badge) ?? causalityLevel(badge) ?? badge.count ?? 1}</small
        >
      </span>`,
    )}
  </span>`;
}
