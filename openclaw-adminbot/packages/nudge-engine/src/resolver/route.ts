/**
 * Routing: turn frontier nodes into nudges aimed at the right person.
 *
 * All the "who hears about it" policy lives here. The graph modules stay pure.
 */

import type { Graph, Nudge, NodeId, Role, Status } from "../types.ts";
import { isLeaf, nodeById, predecessors, successors } from "./graph-ops.ts";
import { unblockedBy } from "./frontier.ts";
import { resolveActionable } from "./resolve.ts";

export type StatusMap = Map<NodeId, Status>;

export type RouteOptions = {
  /** Today, for external-wait due-date comparisons. */
  now?: Date;
  /**
   * Branch name → sort weight, lower first. Supplied by the caller so `resolver/` never has to
   * know which graph it is running on.
   */
  branchPriority?: Record<string, number>;
  /**
   * Set when the PI is the person blocking. Escalating the PI to themselves is a no-op
   * that also looks broken, so the author and the admin board are told instead.
   */
  piIsBlockedApprover?: boolean;
};

export function routeFrontier(
  graph: Graph,
  frontierIds: NodeId[],
  status: StatusMap,
  state: { version: string; expectedDates?: Partial<Record<NodeId, string>> },
  options: RouteOptions = {},
): Nudge[] {
  const now = options.now ?? new Date();
  const branchPriority = options.branchPriority ?? {};
  const byId = nodeById(graph);
  const out: Nudge[] = [];
  const seen = new Set<NodeId>();

  const push = (n: Nudge) => {
    if (seen.has(n.node)) return;
    seen.add(n.node);
    out.push(n);
  };

  for (const id of frontierIds) {
    const node = byId.get(id);
    if (!node) continue;

    const sibling = siblingFor(graph, id, status);
    const base = {
      node: id,
      nodeLabel: node.label,
      unblocks: unblockedBy(graph, id, status),
      priority: branchPriority[node.branch ?? ""] ?? 9,
      ...(sibling ? { sibling } : {}),
    };

    switch (node.cls) {
      // Joins and decisions are never nudged. Resolve through to what is actually missing.
      case "join":
      case "decision": {
        for (const actionable of resolveActionable(graph, id, status)) {
          const target = byId.get(actionable);
          if (!target?.owner) continue;
          push({
            node: actionable,
            nodeLabel: target.label,
            kind: target.cls === "approval" ? "approval" : "action",
            recipient: target.owner,
            reason: `${node.label} is waiting on this`,
            unblocks: unblockedBy(graph, actionable, status),
            // Resolved *through* this join, so the sibling is relative to it — that is the
            // whole point of the message: tell each side what the other is doing.
            sibling: otherInputOf(graph, id, actionable, status),
            ...(target.versioned ? { version: state.version } : {}),
            priority: branchPriority[target.branch ?? ""] ?? 9,
          });
        }
        break;
      }

      case "approval": {
        if (!node.owner) break;
        push({
          ...base,
          kind: "approval",
          recipient: node.owner,
          reason: "Prepared and waiting on your explicit yes — preparation is not permission",
          ...(node.versioned ? { version: state.version } : {}),
        });
        break;
      }

      // Never ask a person to make a third party respond. Do ask them to report it once
      // the expected date has passed, or the branch freezes silently.
      case "external_wait": {
        const due = state.expectedDates?.[id];
        if (!due) break;
        if (new Date(due).getTime() > now.getTime()) break;
        if (!node.owner) break;
        push({
          ...base,
          kind: "observe",
          recipient: node.owner,
          reason: `Expected by ${due} — has it happened? This is a status check, not a task`,
          priority: -1, // a frozen venue branch outranks everything
        });
        break;
      }

      case "optional": {
        if (!node.owner) break;
        push({ ...base, kind: "optional", reason: "Optional — this blocks nothing", recipient: node.owner, priority: 9 });
        break;
      }

      case "or_join":
      case "action": {
        if (!node.owner) break;
        push({
          ...base,
          kind: "action",
          recipient: node.owner,
          reason: isLeaf(graph, id)
            ? "Last step on this branch — it blocks nothing else"
            : "You are up",
          ...(node.versioned ? { version: state.version } : {}),
        });
        break;
      }
    }
  }

  // A hard deadline outranks branch order entirely.
  for (const n of out) {
    if (byId.get(n.node)?.hardDeadline) n.priority = -2;
  }

  return out.sort((a, b) => a.priority - b.priority || a.node.localeCompare(b.node));
}

/**
 * The other input to the nearest downstream join, and whether it is already waiting.
 *
 * This walks *forward* from the node being nudged rather than backward from the join,
 * because the person doing a step usually cannot see the join at all. `GT` and `CP` sit on
 * opposite branches that meet at `JN`; without this, the PI is never told that the social
 * post is finished and waiting on them, and the author is never told the reverse. Each
 * side then assumes the other owes something and neither moves.
 */
function siblingFor(graph: Graph, from: NodeId, status: StatusMap): Nudge["sibling"] {
  const byId = nodeById(graph);

  // Only a *direct* input to a join gets sibling context. Walking further downstream finds
  // a join eventually for almost every node — `CK` reaches `JN` nine hops away — and
  // telling someone doing submission checks that the social draft is "also needed" is
  // noise that makes the whole message look automated and wrong.
  const join = successors(graph, from).find((s) => byId.get(s)?.cls === "join");
  if (!join) return undefined;

  return otherInputOf(graph, join, from, status);
}

/**
 * The other input to a specific join, given which side we arrived from.
 */
function otherInputOf(
  graph: Graph,
  joinId: NodeId,
  ourSide: NodeId,
  status: StatusMap,
): Nudge["sibling"] {
  const byId = nodeById(graph);
  const preds = predecessors(graph, joinId).filter((p) => status.get(p) !== "not_applicable");

  // `ourSide` may be the direct input, or something further upstream that feeds it.
  const ours = preds.find(
    (p) => p === ourSide || resolveActionable(graph, p, status).has(ourSide),
  );
  const other = preds.find((p) => p !== ours);
  if (!other) return undefined;

  const node = byId.get(other);
  if (!node) return undefined;
  return { node: other, label: node.label, complete: status.get(other) === "complete" };
}

/** One message per person, however many nodes it covers. */
export function batchByRecipient(nudges: Nudge[]): { recipient: Role; nudges: Nudge[] }[] {
  const groups = new Map<Role, Nudge[]>();
  for (const n of nudges) {
    const list = groups.get(n.recipient) ?? [];
    list.push(n);
    groups.set(n.recipient, list);
  }
  return [...groups.entries()]
    .map(([recipient, list]) => ({ recipient, nudges: list }))
    .sort((a, b) => (a.nudges[0]?.priority ?? 9) - (b.nudges[0]?.priority ?? 9));
}
