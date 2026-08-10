#!/usr/bin/env node
// Check Layering enforces the dependency-direction rules ADR-0001 chose over a
// folder reshape: the tree keeps its shape and the import graph is policed by a
// rule set instead.
//
// Two kinds of rule live here, and the difference matters:
//
//   - The **frozen edge set** is a ratchet, not a judgement. Every top-level
//     `src/` domain edge that exists today is listed in `config/layering.json`;
//     an edge that is not listed fails. That makes a new cross-domain
//     dependency a deliberate config change rather than a silent one. It says
//     nothing about whether the existing edges are good.
//   - The **directional rules** are judgements, and they fail regardless of
//     what the frozen set says. `plugin-sdk` is the port surface (ADR-0003) and
//     must not reach into the gateway/CLI/command layers even if it does today.
//
// `src/agents` is the application layer (ADR-0004): its outward edges are
// in-direction by definition, so no rule constrains them. The rule that
// protects that boundary — peers not deep-importing `agents` — is carried by
// the frozen set, which is where those inward edges are grandfathered.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildImportGraph } from "./lib/import-cycle-graph.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "config", "layering.json");

/** Domain name used for files sitting directly in `src/`. */
export const rootDomain = "(root)";

export type LayeringRules = {
  applicationLayer: { domains: string[]; note?: string };
  portSurface: {
    domains: string[];
    forbiddenTargets: string[];
    grandfathered: string[];
    note?: string;
  };
  leaf: { domains: string[]; allowedTargets: string[]; mode: "fail" | "warn"; note?: string };
};

export type LayeringConfig = {
  _doc?: unknown;
  rules: LayeringRules;
  frozenEdges: string[];
};

export type DomainEdge = {
  key: string;
  from: string;
  to: string;
  count: number;
  /** One importer/imported pair, so a failure names a file to open. */
  sample: { from: string; to: string };
};

export type LayeringFinding = {
  rule: "frozen-edge" | "port-surface" | "leaf" | "prunable-frozen-edge";
  edge: string;
  detail: string;
};

/**
 * Maps a repo path to its top-level `src/` domain.
 *
 * Returns null for anything outside `src/` — `extensions/` and `scripts/` are
 * in the graph so relative specifiers resolve, but they are not domains.
 */
export function domainForRepoPath(repoPath: string): string | null {
  if (!repoPath.startsWith("src/")) {
    return null;
  }
  const rest = repoPath.slice("src/".length);
  const slashIndex = rest.indexOf("/");
  return slashIndex === -1 ? rootDomain : rest.slice(0, slashIndex);
}

/**
 * Reduces the file-level import graph to the `src/` top-level domain edge set.
 *
 * Self-edges (a domain importing itself) are dropped: they carry no layering
 * information and would swamp the frozen list.
 */
export function collectDomainEdges(graph: ReadonlyMap<string, readonly string[]>): DomainEdge[] {
  const edges = new Map<string, DomainEdge>();
  for (const [file, imports] of graph) {
    const from = domainForRepoPath(file);
    if (!from) {
      continue;
    }
    for (const imported of imports) {
      const to = domainForRepoPath(imported);
      if (!to || to === from) {
        continue;
      }
      const key = `${from}->${to}`;
      const existing = edges.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      edges.set(key, { key, from, to, count: 1, sample: { from: file, to: imported } });
    }
  }
  return [...edges.values()].toSorted((left, right) => left.key.localeCompare(right.key));
}

/**
 * Applies the frozen set and the directional rules to an edge set.
 *
 * Pure: takes the edges and the config, returns findings. The runner does the
 * I/O and the exit code.
 */
export function evaluateLayering(
  edges: readonly DomainEdge[],
  config: LayeringConfig,
): { failures: LayeringFinding[]; warnings: LayeringFinding[] } {
  const failures: LayeringFinding[] = [];
  const warnings: LayeringFinding[] = [];
  const frozen = new Set(config.frozenEdges);
  const present = new Set(edges.map((edge) => edge.key));

  const portDomains = new Set(config.rules.portSurface.domains);
  const forbiddenPortTargets = new Set(config.rules.portSurface.forbiddenTargets);
  const grandfatheredPortEdges = new Set(config.rules.portSurface.grandfathered);
  const leafDomains = new Set(config.rules.leaf.domains);
  const leafAllowed = new Set(config.rules.leaf.allowedTargets);

  for (const edge of edges) {
    const where = `${edge.sample.from} -> ${edge.sample.to}`;
    // Hard rule: holds whether or not the edge is frozen, so listing a
    // forbidden edge in frozenEdges cannot launder it. The named
    // `grandfathered` edges are the exception, and only they.
    if (portDomains.has(edge.from) && forbiddenPortTargets.has(edge.to)) {
      const grandfathered = grandfatheredPortEdges.has(edge.key);
      const finding: LayeringFinding = {
        rule: "port-surface",
        edge: edge.key,
        detail: grandfathered
          ? `${edge.from} still imports ${edge.to} (${edge.count} import(s), e.g. ${where}); grandfathered in config/layering.json — remove the imports, then drop it from rules.portSurface.grandfathered`
          : `${edge.from} is the port surface and must not import ${edge.to} (${edge.count} import(s), e.g. ${where}) — see docs/adr/0003-plugin-sdk-stays-flat.md`,
      };
      (grandfathered ? warnings : failures).push(finding);
    }
    if (leafDomains.has(edge.from) && !leafAllowed.has(edge.to)) {
      const finding: LayeringFinding = {
        rule: "leaf",
        edge: edge.key,
        detail: `${edge.from} is a leaf and must not import ${edge.to} (${edge.count} import(s), e.g. ${where}) — see docs/adr/0005-shared-is-the-helper-home.md`,
      };
      (config.rules.leaf.mode === "fail" ? failures : warnings).push(finding);
    }
    if (!frozen.has(edge.key)) {
      failures.push({
        rule: "frozen-edge",
        edge: edge.key,
        detail: `new cross-domain edge (${edge.count} import(s), e.g. ${where}); add it to config/layering.json frozenEdges only if the dependency is intended`,
      });
    }
  }

  for (const key of config.frozenEdges) {
    if (!present.has(key)) {
      warnings.push({
        rule: "prunable-frozen-edge",
        edge: key,
        detail: "frozen edge no longer exists; prune it from config/layering.json",
      });
    }
  }
  for (const key of config.rules.portSurface.grandfathered) {
    if (!present.has(key)) {
      warnings.push({
        rule: "prunable-frozen-edge",
        edge: key,
        detail:
          "port-surface exception no longer needed; prune it from rules.portSurface.grandfathered",
      });
    }
  }

  return { failures, warnings };
}

/**
 * Reads and shallowly validates `config/layering.json`.
 */
export function parseLayeringConfig(raw: string): LayeringConfig {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("config/layering.json must be an object");
  }
  const candidate = parsed as Partial<LayeringConfig>;
  if (!Array.isArray(candidate.frozenEdges)) {
    throw new TypeError("config/layering.json must declare a frozenEdges array");
  }
  const rules = candidate.rules;
  if (!rules?.applicationLayer || !rules.portSurface || !rules.leaf) {
    throw new TypeError(
      "config/layering.json must declare rules.applicationLayer, rules.portSurface and rules.leaf",
    );
  }
  if (!Array.isArray(rules.portSurface.grandfathered)) {
    throw new TypeError(
      "config/layering.json rules.portSurface must declare a grandfathered array (use [] for none)",
    );
  }
  if (rules.leaf.mode !== "fail" && rules.leaf.mode !== "warn") {
    throw new TypeError('config/layering.json rules.leaf.mode must be "fail" or "warn"');
  }
  // Spread rather than pick, so the `_doc` key (JSON has no comments, so the
  // documentation is data) survives a `--freeze` round-trip.
  return { ...candidate, frozenEdges: candidate.frozenEdges, rules };
}

function writeFrozenEdges(config: LayeringConfig, edges: readonly DomainEdge[]): void {
  const next: LayeringConfig = {
    ...config,
    frozenEdges: edges.map((edge) => edge.key).toSorted((left, right) => left.localeCompare(right)),
  };
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
}

function main(argv: readonly string[]): number {
  const freeze = argv.includes("--freeze");
  const config = parseLayeringConfig(readFileSync(configPath, "utf8"));
  // Type-only edges count here: a type dependency still points one domain at
  // another, and freezing only runtime edges would let a domain acquire a new
  // neighbour silently by importing its types.
  const graph = buildImportGraph({ repoRoot });
  const edges = collectDomainEdges(graph);

  if (freeze) {
    writeFrozenEdges(config, edges);
    console.log(
      `Layering check: froze ${edges.length} src/ domain edge(s) into config/layering.json.`,
    );
    return 0;
  }

  const { failures, warnings } = evaluateLayering(edges, config);
  console.log(
    `Layering check: ${edges.length} src/ domain edge(s), ${config.frozenEdges.length} frozen, ` +
      `${failures.length} failure(s), ${warnings.length} warning(s).`,
  );

  for (const warning of warnings) {
    console.error(`[layering] WARNING ${warning.rule}: ${warning.edge} — ${warning.detail}`);
  }
  if (failures.length === 0) {
    return 0;
  }
  console.error("\nLayering violations:");
  for (const failure of failures) {
    console.error(`  ${failure.rule}: ${failure.edge}\n    ${failure.detail}`);
  }
  console.error(
    "\nRe-freeze with `pnpm check:layering --freeze` only when the new edges are deliberate.",
  );
  return 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
