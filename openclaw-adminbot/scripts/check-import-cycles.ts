#!/usr/bin/env node
// Check Import Cycles script supports OpenClaw repository automation.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildImportGraph,
  collectStronglyConnectedComponents,
  formatCycle,
} from "./lib/import-cycle-graph.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function main(): number {
  // Type-only edges are erased at runtime, so they cannot form a runtime cycle.
  const graph = buildImportGraph({ repoRoot, runtimeOnly: true });
  const components = collectStronglyConnectedComponents(graph);

  console.log(`Import cycle check: ${components.length} runtime value cycle(s).`);
  if (components.length === 0) {
    return 0;
  }

  console.error("\nRuntime value import cycles:");
  for (const component of components) {
    console.error(`\n# component size ${component.length}`);
    console.error(formatCycle(component, graph));
  }
  console.error("\nBreak the cycle or convert type-only edges to `import type`.");
  return 1;
}

process.exitCode = main();
