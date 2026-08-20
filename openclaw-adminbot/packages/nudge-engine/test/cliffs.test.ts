/**
 * One test per numbered cliff in the register.
 *
 * This file is the reason to trust the module. Each case is a state the graph can actually
 * reach, and each asserts the behaviour that stops it being a hole. If someone edits the
 * graph and reintroduces a cliff, the test named after it fails.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyReset, emptyState } from "../src/adapters/backend.ts";
import { paperflow, resetScope } from "../src/graph/paperflow.ts";
import { tick, whyBlocked } from "../src/nudge.ts";
import { frontier } from "../src/resolver/frontier.ts";
import { isAcyclic } from "../src/resolver/graph-ops.ts";
import { prune, effectiveStatus } from "../src/resolver/prune.ts";
import { resolveActionable } from "../src/resolver/resolve.ts";
import type { NodeId, PaperState, Status } from "../src/types.ts";

/** Mark a list of nodes complete, everything else incomplete. */
function withComplete(...ids: NodeId[]): PaperState {
  const status: Partial<Record<NodeId, Status>> = {};
  for (const id of ids) status[id] = "complete";
  return { ...emptyState("p1"), status };
}

const throughPdf: NodeId[] = ["BR", "OV", "PM", "FX", "PDF"];

describe("cliff 1-2 — cycles", () => {
  it("the dependency subgraph is acyclic once reset/retry are excluded", () => {
    assert.equal(isAcyclic(paperflow), true);
  });

  it("resolving PS terminates and never returns PS itself", () => {
    const state = withComplete(...throughPdf, "XD", "LI", "CP", "SF", "DR", "DA", "AK", "PK");
    const { notApplicable } = prune(paperflow, state);
    const status = effectiveStatus(paperflow, state, { notApplicable, prunedEdges: new Set() });

    const actionable = resolveActionable(paperflow, "PS", status);
    assert.ok(!actionable.has("PS"), "must not nudge the blocked task itself");
    assert.ok(actionable.has("GT"), "the real blocker is the approval gate");
  });
});

describe("cliff 3-4 — reset scope", () => {
  it("a rejection preserves branches 1-3 and re-opens only the venue subtree", () => {
    const done = withComplete(
      ...throughPdf,
      "SL",
      "PO",
      "TV",
      "XD",
      "LI",
      "CP",
      "SF",
      "CK",
      "SB",
      "RV",
      "DC",
    );
    const after = applyReset(done, resetScope);

    for (const id of resetScope.survives) {
      if (done.status[id] === "complete") {
        assert.equal(after.status[id], "complete", `${id} must survive a rejection`);
      }
    }
    for (const id of resetScope.cleared) {
      assert.equal(after.status[id], "incomplete", `${id} must be cleared`);
    }
    assert.equal(after.attempt, 2, "a rejection opens the next attempt");
  });
});

describe("cliff 6-7 — joins", () => {
  it("a join is never nudged directly", () => {
    // JN is the remaining AND-join: the public arXiv URL on one side, the finished social copy on
    // the other. The talk branch used to carry one too, until the shared-folder node it closed was
    // merged into the project folder the paper starts from.
    const state = withComplete(...throughPdf, "XD", "LI", "CP", "SF");
    const result = tick(paperflow, state);
    const nudged = result.batches.flatMap((b) => b.nudges).map((n) => n.node);
    assert.ok(!nudged.includes("JN"), "JN is an AND-join and must resolve through");
    assert.ok(!nudged.includes("PS"), "the join's successor is not actionable either");
  });

  it("resolve returns a set, so both sides of an AND-join are nudged", () => {
    const state = withComplete(...throughPdf, "XD", "LI", "DR", "DA", "AK");
    const { notApplicable, prunedEdges } = prune(paperflow, state);
    const status = effectiveStatus(paperflow, state, { notApplicable, prunedEdges });

    const actionable = resolveActionable(paperflow, "JN", status);
    assert.ok(actionable.has("CP"), "social side must be nudged");
    assert.ok(actionable.has("PK"), "arXiv side must be nudged");
    assert.equal(actionable.size, 2, "exactly both sides, nothing else");
  });

  it("a join nudge names the sibling's state", () => {
    const state = withComplete(...throughPdf, "XD", "LI", "CP", "SF", "DR", "DA", "AK", "PK");
    const result = tick(paperflow, state);
    const gate = result.batches.flatMap((b) => b.nudges).find((n) => n.node === "GT");
    assert.ok(gate, "the gate must be nudged");
    assert.ok(gate?.sibling, "the message must carry the other input");
    assert.equal(gate?.sibling?.complete, true, "and say it is already waiting");
  });
});

describe("cliff 9-12 — pruning", () => {
  it("a reject marks Camera ready not applicable rather than incomplete", () => {
    const state: PaperState = {
      ...withComplete(...throughPdf, "CK", "SB", "RV", "DC"),
      decisions: { RB: "DC", AC: "RJ" },
    };
    const { notApplicable } = prune(paperflow, state);
    assert.ok(notApplicable.has("CM"), "CM is unreachable after a reject");
  });

  it("cliff 11 — a reject does NOT deadlock the arXiv branch", () => {
    const state: PaperState = {
      ...withComplete(...throughPdf, "CK", "SB", "RV", "DC", "DR", "DA", "AK"),
      decisions: { RB: "DC", AC: "RJ" },
    };
    const { notApplicable } = prune(paperflow, state);

    assert.ok(!notApplicable.has("PK"), "PK stays live via the preprint path");
    assert.ok(!notApplicable.has("GT"), "the gate stays reachable");
    assert.ok(!notApplicable.has("PS"), "publication stays reachable");

    const status = effectiveStatus(paperflow, state, { notApplicable, prunedEdges: new Set() });
    assert.ok(frontier(paperflow, status).includes("PK"), "and PK is actionable right now");
  });

  it("a No on the rebuttal window prunes Rebuttal submitted", () => {
    const state: PaperState = {
      ...withComplete(...throughPdf, "CK", "SB", "RV"),
      decisions: { RB: "DC" },
    };
    const { notApplicable } = prune(paperflow, state);
    assert.ok(notApplicable.has("RS"));
    assert.ok(!notApplicable.has("DC"), "DC is still reachable directly from RB");
  });

  it("cliff 12 — pruning is recomputed, so attempt 2 is not poisoned", () => {
    const rejected: PaperState = {
      ...withComplete(...throughPdf, "CK", "SB", "RV", "DC"),
      decisions: { RB: "DC", AC: "RJ" },
    };
    assert.ok(prune(paperflow, rejected).notApplicable.has("CM"));

    const next = applyReset(rejected, resetScope);
    assert.ok(
      !prune(paperflow, next).notApplicable.has("CM"),
      "attempt 2 can reach camera ready again",
    );
  });
});

describe("cliff 13-16 — approval", () => {
  it("cliff 13 — a prepared package does not satisfy the gate", () => {
    const state = withComplete(...throughPdf, "DR", "DA", "AK", "PK");
    const result = tick(paperflow, state);
    const nudged = result.batches.flatMap((b) => b.nudges);
    const gate = nudged.find((n) => n.node === "GT");
    assert.ok(gate, "GT must still be pending after PK completes");
    assert.match(gate?.reason ?? "", /not permission/i);
  });

  it("cliff 14 — the gate is routed to the PI, never the author", () => {
    const state = withComplete(...throughPdf, "DR", "DA", "AK", "PK");
    const result = tick(paperflow, state);
    const gate = result.batches.flatMap((b) => b.nudges).find((n) => n.node === "GT");
    assert.equal(gate?.recipient, "pi");
  });

  it("the gate nudge names the version being asked about", () => {
    const state = {
      ...withComplete(...throughPdf, "DR", "DA", "AK", "PK"),
      version: "camera-ready",
    };
    const result = tick(paperflow, state);
    const gate = result.batches.flatMap((b) => b.nudges).find((n) => n.node === "GT");
    assert.equal(gate?.version, "camera-ready");
  });
});

describe("cliff 18-21 — external wait", () => {
  it("cliff 18 — Reviews out is not nudged before its expected date", () => {
    const state: PaperState = {
      ...withComplete(...throughPdf, "CK", "SB"),
      expectedDates: { RV: "2099-01-01" },
    };
    const result = tick(paperflow, state, { now: new Date("2026-01-01") });
    const nudged = result.batches.flatMap((b) => b.nudges).map((n) => n.node);
    assert.ok(!nudged.includes("RV"), "nobody can make a venue respond");
  });

  it("cliff 20 — past the expected date it becomes an observation nudge", () => {
    const state: PaperState = {
      ...withComplete(...throughPdf, "CK", "SB"),
      expectedDates: { RV: "2026-01-01" },
    };
    const result = tick(paperflow, state, { now: new Date("2026-02-01") });
    const rv = result.batches.flatMap((b) => b.nudges).find((n) => n.node === "RV");
    assert.ok(rv, "an unobserved venue freezes 7 nodes — it must be chased");
    assert.equal(rv?.kind, "observe");
  });

  it("cliff 21 — waiting on a venue is quiet, not a stall alert", () => {
    const status: Partial<Record<NodeId, Status>> = {};
    for (const n of paperflow.nodes) status[n.id] = "complete";
    status["RV"] = "waiting_external";
    status["RB"] = "incomplete";

    const state: PaperState = { ...emptyState("p1"), status, decisions: {} };
    const result = tick(paperflow, state);
    assert.notEqual(result.outcome, "stall", "a silent venue must not look like a broken graph");
  });
});

describe("cliff 22-24 — volume", () => {
  it("cliff 22 — four parallel branches batch into one message per person", () => {
    const state = withComplete(...throughPdf);
    const result = tick(paperflow, state);

    const authorBatches = result.batches.filter((b) => b.recipient === "first_author");
    assert.equal(authorBatches.length, 1, "one message, not four");
    assert.ok((authorBatches[0]?.nudges.length ?? 0) >= 4, "covering every open branch");
  });

  it("cliff 23 — the venue branch outranks cosmetic work", () => {
    const state = withComplete(...throughPdf);
    const result = tick(paperflow, state);
    const nudges = result.batches.flatMap((b) => b.nudges);
    const venue = nudges.findIndex((n) => n.node === "CK");
    const talk = nudges.findIndex((n) => n.node === "SL");
    assert.ok(venue < talk, "deadline-bearing work is ordered first");
  });

  it("cliff 24 — a leaf that blocks nothing says so", () => {
    // The talk branch ends at its two leaves. It used to converge on a "links logged in shared
    // folder" join, which was removed once that folder became the same living project folder the
    // paper starts from -- so the join only ever asked somebody to confirm a copy of a fact.
    const state = withComplete(...throughPdf, "SL");
    const result = tick(paperflow, state);
    const talkVideo = result.batches.flatMap((b) => b.nudges).find((n) => n.node === "TV");
    assert.ok(talkVideo);
    assert.equal(talkVideo?.unblocks.length, 0);
    assert.match(talkVideo?.reason ?? "", /blocks nothing/i);
  });

  it("cliff 24b — the removed nodes are gone from the graph, not just unreferenced", () => {
    const ids = new Set(paperflow.nodes.map((node) => node.id));
    assert.ok(!ids.has("DS"), "one Drive PDF per paper, not two");
    assert.ok(!ids.has("LG"), "the shared folder is the project folder");
    // Nothing may still point at them, or the resolver walks off the graph.
    for (const edge of paperflow.edges) {
      assert.ok(ids.has(edge.from), `edge from ${edge.from}`);
      assert.ok(ids.has(edge.to), `edge to ${edge.to}`);
    }
  });
});

describe("cliff 25 — ownership", () => {
  it("an unowned actionable node makes the whole graph refuse to nudge", () => {
    const broken = {
      ...paperflow,
      nodes: paperflow.nodes.map((n) => (n.id === "SL" ? { ...n, owner: undefined } : n)),
    };
    const result = tick(broken, withComplete(...throughPdf));
    assert.equal(result.outcome, "config_error");
    assert.equal(result.batches.length, 0, "zero nudges, not a partial set");
  });
});

describe("cliff 27-29 — semantics and silence", () => {
  it("cliff 27 — an optional node never blocks and is marked as such", () => {
    const state = withComplete(...throughPdf, "DR", "DA", "AK", "PK", "GT");
    const result = tick(paperflow, state);
    const be = result.batches.flatMap((b) => b.nudges).find((n) => n.node === "BE");
    assert.equal(be?.kind, "optional");
  });

  it("cliff 28 — decisions are never nudged as tasks", () => {
    const state = withComplete(...throughPdf, "CK", "SB", "RV");
    const result = tick(paperflow, state);
    const nudged = result.batches.flatMap((b) => b.nudges).map((n) => n.node);
    assert.ok(!nudged.includes("RB"), "nobody completes a rebuttal window");
    assert.ok(!nudged.includes("AC"), "nobody completes an acceptance");
  });

  it("cliff 29 — an empty frontier with nothing finished is a stall, not silence", () => {
    const status: Partial<Record<NodeId, Status>> = {};
    for (const n of paperflow.nodes) status[n.id] = "complete";
    // Decisions must be recorded too — "every node complete but nothing decided" is not a
    // finished paper, it is a status feed that never wrote the outcomes down.
    const done = tick(paperflow, {
      ...emptyState("p1"),
      status,
      decisions: { RB: "DC", AC: ["CM", "CA"] },
    });
    assert.equal(done.outcome, "done");
  });

  it("an undecided decision with everything else complete is not 'done'", () => {
    const status: Partial<Record<NodeId, Status>> = {};
    for (const n of paperflow.nodes) status[n.id] = "complete";
    const result = tick(paperflow, { ...emptyState("p1"), status });
    assert.notEqual(result.outcome, "done", "an unrecorded outcome must not read as finished");
  });
});

describe("whyBlocked — the user-facing question", () => {
  it("answers 'why is Publish stuck' with the real owners, not the author", () => {
    const state = withComplete(...throughPdf, "XD", "LI", "DR", "DA", "AK", "PK");
    const answer = whyBlocked(paperflow, state, "PS");

    assert.equal(answer.blocked, true);
    assert.deepEqual(answer.actionable.sort(), ["CP", "GT"]);
    assert.ok(answer.actionableLabels.includes("Coauthor feedback"));
    assert.ok(answer.actionableLabels.includes("Zhijing explicit yes"));
  });
});

describe("conference attendance — a decision that opens two branches", () => {
  const submitted = [...throughPdf, "CK", "SB", "RV", "DC"] as NodeId[];

  it("accept as first author keeps BOTH camera ready and conference attendance live", () => {
    const state: PaperState = {
      ...withComplete(...submitted),
      // Accept opens two successors. A single-valued outcome would prune one of them.
      decisions: { RB: "DC", AC: ["CM", "CA"] },
    };
    const { notApplicable } = prune(paperflow, state);

    assert.ok(!notApplicable.has("CM"), "camera ready must stay live");
    assert.ok(!notApplicable.has("CA"), "conference attendance must stay live");
    assert.ok(!notApplicable.has("RM"), "and reimbursement after it");
    assert.ok(notApplicable.has("RJ"), "the rejection branch is pruned");

    const status = effectiveStatus(paperflow, state, { notApplicable, prunedEdges: new Set() });
    const open = frontier(paperflow, status);
    assert.ok(open.includes("CM") && open.includes("CA"), "both are actionable at once");
  });

  it("accept as a non-first author prunes the conference subtree only", () => {
    const state: PaperState = {
      ...withComplete(...submitted),
      decisions: { RB: "DC", AC: ["CM"] },
    };
    const { notApplicable } = prune(paperflow, state);

    assert.ok(!notApplicable.has("CM"), "camera ready is unaffected");
    assert.ok(notApplicable.has("CA"), "no travel for a non-first author");
    assert.ok(notApplicable.has("RM"), "and RM is only reachable through CA");
  });

  it("a rejection prunes the whole conference subtree", () => {
    const state: PaperState = {
      ...withComplete(...submitted),
      decisions: { RB: "DC", AC: "RJ" },
    };
    const { notApplicable } = prune(paperflow, state);
    assert.ok(notApplicable.has("CA"));
    assert.ok(notApplicable.has("RM"), "nobody books travel for a rejected paper");
  });

  it("reimbursement waits for the conference to happen", () => {
    const state: PaperState = {
      ...withComplete(...submitted),
      decisions: { RB: "DC", AC: ["CM", "CA"] },
    };
    const { notApplicable } = prune(paperflow, state);
    const status = effectiveStatus(paperflow, state, { notApplicable, prunedEdges: new Set() });
    assert.ok(!frontier(paperflow, status).includes("RM"), "RM is not actionable before CA");
  });

  it("the graph is still acyclic with the new nodes", () => {
    assert.equal(isAcyclic(paperflow), true);
  });
});
