/**
 * Message copy.
 *
 * Kept separate from routing so wording can change without touching logic, and so the
 * frontend can render its own copy from the same `Nudge` objects if it prefers.
 *
 * Two rules the copy must never break:
 *   - name what the step unblocks, so the recipient can see why it matters
 *   - on a join, say whether the other side is already waiting
 */

import type { Graph, Nudge } from "./types.ts";
import { nodeById } from "./resolver/graph-ops.ts";

export function nudgeText(graph: Graph, nudge: Nudge): string {
  const byId = nodeById(graph);
  const lines: string[] = [];

  const version = nudge.version ? ` (${nudge.version})` : "";

  switch (nudge.kind) {
    case "approval":
      lines.push(`${nudge.nodeLabel}${version} is waiting on your yes.`);
      break;
    case "observe":
      lines.push(`Quick check: ${nudge.nodeLabel}. ${nudge.reason}`);
      break;
    case "optional":
      lines.push(`Optional: ${nudge.nodeLabel}. Nothing is blocked by this.`);
      break;
    case "escalate":
      lines.push(`Escalation: ${nudge.nodeLabel} has been waiting past its window.`);
      break;
    default:
      lines.push(`Next up: ${nudge.nodeLabel}${version}.`);
  }

  if (nudge.sibling) {
    lines.push(
      nudge.sibling.complete
        ? `"${nudge.sibling.label}" is already done and waiting on this.`
        : `"${nudge.sibling.label}" is also outstanding — both are needed.`,
    );
  }

  if (nudge.unblocks.length > 0) {
    const names = nudge.unblocks.map((id) => byId.get(id)?.label ?? id);
    lines.push(`Finishing it unblocks: ${names.join(", ")}.`);
  }

  return lines.join(" ");
}

export function batchText(graph: Graph, recipient: string, nudges: Nudge[]): string {
  if (nudges.length === 1) return nudgeText(graph, nudges[0] as Nudge);
  const items = nudges.map((n, i) => `${i + 1}. ${nudgeText(graph, n)}`);
  return [`${nudges.length} things are waiting on you:`, ...items].join("\n");
}
