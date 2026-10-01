import { html } from "lit";
import { adminBotBadgeEmoji } from "../../../../../extensions/adminbot/src/contracts/badges.js";
import type { AssignedBadge } from "../auth/session.ts";

function causalityLevel(badge: Pick<AssignedBadge, "name" | "tier">): string | undefined {
  return badge.name === "Causality" ? /^Level ([123])$/u.exec(badge.tier ?? "")?.[1] : undefined;
}

export function badgeCountLabel(badge: Pick<AssignedBadge, "name" | "tier" | "count">): string {
  const label = badge.tier ? `${badge.name} · ${badge.tier}` : badge.name;
  return causalityLevel(badge) ? label : `${label} ×${badge.count ?? 1}`;
}

export function renderMemberBadgeSymbols(badges: readonly AssignedBadge[] = []) {
  return html`<span class="adminbot-member-badge-symbols"
    >${badges.map(
      (badge) => html` <span
        tabindex="0"
        title=${`${badgeCountLabel(badge)} — ${badge.description}`}
        aria-label=${badgeCountLabel(badge)}
      >
        ${adminBotBadgeEmoji(badge.name)}<small>${causalityLevel(badge) ?? badge.count ?? 1}</small>
      </span>`,
    )}
  </span>`;
}
