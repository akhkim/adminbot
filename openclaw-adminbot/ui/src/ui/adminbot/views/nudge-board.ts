import { html } from "lit";
import type { AdminBotDashboardData } from "../controllers/admin.ts";
import { stepLabels } from "../data/paper-steps.ts";
import { renderQueueMore } from "./queue-more.ts";

// The Paper Overview's "due nudges" board, split out of admin.ts when it gained a pager.

function friendly(value: string): string {
  return value
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function renderNudges(data: AdminBotDashboardData, onMore?: () => void) {
  const nudges = data.nudges;
  if (nudges.length === 0) {
    return html`<div class="adminbot-empty adminbot-empty--compact">No due paper nudges.</div>`;
  }
  return html`
    <div class="adminbot-nudge-list">
      ${nudges.map(
        (nudge) => html`
          <article class="adminbot-nudge adminbot-nudge--${nudge.type}">
            <div class="adminbot-nudge__header">
              <strong>${nudge.title}</strong>
              <span>${nudge.type === "head_professor_escalation" ? "Escalate" : "Nudge"}</span>
            </div>
            <p>${nudge.message}</p>
            <div class="adminbot-action__meta">
              <span>${stepLabels[nudge.step] ?? friendly(nudge.step)}</span>
              <span>${nudge.recipients.join(", ") || "No recipients"}</span>
            </div>
          </article>
        `,
      )}
    </div>
    ${renderQueueMore(data.queuePages?.nudges, nudges.length, onMore)}
  `;
}
