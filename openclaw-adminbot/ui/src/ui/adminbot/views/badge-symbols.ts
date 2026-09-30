import { html } from "lit";
import { adminBotBadgeEmoji } from "../../../../../extensions/adminbot/src/contracts/badges.js";
import type { AssignedBadge } from "../auth/session.ts";

export function badgeCountLabel(badge: Pick<AssignedBadge, "name" | "tier" | "count">): string {
  const label = badge.tier ? `${badge.name} · ${badge.tier}` : badge.name;
  return `${label} ×${badge.count ?? 1}`;
}

export function renderMemberBadgeSymbols(badges: readonly AssignedBadge[] = []) {
  return html`<span class="adminbot-member-badge-symbols"
    >${badges.map(
      (badge) => html` <span
        tabindex="0"
        title=${`${badgeCountLabel(badge)} — ${badge.description}`}
        aria-label=${badgeCountLabel(badge)}
      >
        ${adminBotBadgeEmoji(badge.name)}<small>${badge.count ?? 1}</small>
      </span>`,
    )}
  </span>`;
}
