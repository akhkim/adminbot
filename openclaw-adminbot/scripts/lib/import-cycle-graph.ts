// Import Cycle Graph script supports OpenClaw repository automation.
//
// Shared by `scripts/check-import-cycles.ts` and `scripts/check-layering.ts`:
// both need the same file scan, the same relative-specifier resolver and the
// same static-import extraction, and they must agree on which files are in the
// graph or their verdicts stop being comparable.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type SourceFileCollectionOptions = {
  repoRoot: string;
  sourceExtensions: readonly string[];
  shouldSkipRepoPath?: (repoPath: string) => boolean;
};

/** Scan roots both graph checks walk. */
export const graphScanRoots = ["src", "extensions", "scripts"] as const;

/** Extensions treated as graph nodes. */
export const graphSourceExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
] as const;

const testSourcePattern = /(?:\.test|\.e2e\.test)\.[cm]?[tj]sx?$/;
const generatedSourcePattern = /\.(?:generated|bundle)\.[tj]s$/;
const declarationSourcePattern = /\.d\.[cm]?ts$/;
const ignoredPathPartPattern =
  /(^|\/)(node_modules|dist|build|coverage|\.artifacts|\.git|assets)(\/|$)/;

/** True for paths excluded from the graph (tests, generated, declarations, build output). */
export function shouldSkipGraphRepoPath(repoPath: string): boolean {
  return (
    ignoredPathPartPattern.test(repoPath) ||
    testSourcePattern.test(repoPath) ||
    generatedSourcePattern.test(repoPath) ||
    declarationSourcePattern.test(repoPath)
  );
}

function normalizeRepoPath(filePath: string, repoRoot: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function cycleSignature(files: readonly string[]): string {
  return files.toSorted((left, right) => left.localeCompare(right)).join("\n");
}

export function collectSourceFiles(root: string, options: SourceFileCollectionOptions): string[] {
  const repoPath = normalizeRepoPath(root, options.repoRoot);
  if (options.shouldSkipRepoPath?.(repoPath)) {
    return [];
  }
  const stats = statSync(root);
  if (stats.isFile()) {
    return options.sourceExtensions.some((extension) => repoPath.endsWith(extension))
      ? [repoPath]
      : [];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => collectSourceFiles(path.join(root, entry.name), options))
    .toSorted((left, right) => left.localeCompare(right));
}

export type SourceResolver = (importer: string, specifier: string) => string | null;

/**
 * Builds a resolver for relative specifiers over the collected file set.
 *
 * Only relative specifiers resolve: a bare specifier is a package edge, which
 * neither the cycle check nor the layering check models.
 */
export function createSourceResolver(
  files: readonly string[],
  sourceExtensions: readonly string[] = graphSourceExtensions,
): SourceResolver {
  const fileSet = new Set(files);
  const pathMap = new Map<string, string>();
  for (const file of files) {
    const parsed = path.posix.parse(file);
    const extensionless = path.posix.join(parsed.dir, parsed.name);
    pathMap.set(extensionless, file);
    if (file.endsWith(".ts")) {
      pathMap.set(`${extensionless}.js`, file);
    } else if (file.endsWith(".tsx")) {
      pathMap.set(`${extensionless}.jsx`, file);
    } else if (file.endsWith(".mts")) {
      pathMap.set(`${extensionless}.mjs`, file);
    } else if (file.endsWith(".cts")) {
      pathMap.set(`${extensionless}.cjs`, file);
    }
  }
  return (importer: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) {
      return null;
    }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    const candidates = [
      base,
      ...sourceExtensions.map((extension) => `${base}${extension}`),
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.mjs`,
    ];
    for (const candidate of candidates) {
      if (fileSet.has(candidate)) {
        return candidate;
      }
      const mapped = pathMap.get(candidate);
      if (mapped) {
        return mapped;
      }
    }
    return null;
  };
}

function importDeclarationHasRuntimeEdge(node: ts.ImportDeclaration): boolean {
  if (!node.importClause) {
    return true;
  }
  if (node.importClause.isTypeOnly) {
    return false;
  }
  const bindings = node.importClause.namedBindings;
  if (node.importClause.name || !bindings || ts.isNamespaceImport(bindings)) {
    return true;
  }
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntimeEdge(node: ts.ExportDeclaration): boolean {
  if (!node.moduleSpecifier || node.isTypeOnly) {
    return false;
  }
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) {
    return true;
  }
  return clause.elements.some((element) => !element.isTypeOnly);
}

/**
 * Collects resolved static import/export targets for one file.
 *
 * `runtimeOnly` drops type-only edges — required for the cycle check, since a
 * type-only cycle is erased at runtime. The layering check leaves it off: a
 * type dependency still points one directory at another.
 */
export function collectStaticImports(
  file: string,
  options: {
    repoRoot: string;
    resolveSource: SourceResolver;
    runtimeOnly?: boolean;
  },
): string[] {
  const runtimeOnly = options.runtimeOnly ?? false;
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(path.join(options.repoRoot, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    let specifier: string | undefined;
    let include = false;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
      include = !runtimeOnly || importDeclarationHasRuntimeEdge(node);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
      include = !runtimeOnly || exportDeclarationHasRuntimeEdge(node);
    }
    if (include && specifier) {
      const resolved = options.resolveSource(file, specifier);
      if (resolved) {
        imports.push(resolved);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports.toSorted((left, right) => left.localeCompare(right));
}

/**
 * Builds the file-level import graph over the standard scan roots.
 */
export function buildImportGraph(options: {
  repoRoot: string;
  runtimeOnly?: boolean;
  scanRoots?: readonly string[];
}): Map<string, string[]> {
  const scanRoots = options.scanRoots ?? graphScanRoots;
  const files = scanRoots.flatMap((root) =>
    collectSourceFiles(path.join(options.repoRoot, root), {
      repoRoot: options.repoRoot,
      sourceExtensions: graphSourceExtensions,
      shouldSkipRepoPath: shouldSkipGraphRepoPath,
    }),
  );
  const resolveSource = createSourceResolver(files);
  return new Map(
    files.map((file): [string, string[]] => [
      file,
      collectStaticImports(file, {
        repoRoot: options.repoRoot,
        resolveSource,
        runtimeOnly: options.runtimeOnly,
      }),
    ]),
  );
}

export function collectStronglyConnectedComponents(
  graph: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const components: string[][] = [];

  const visit = (node: string) => {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!indexByNode.has(next)) {
        visit(next);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node)!, lowLinkByNode.get(next)!));
      } else if (onStack.has(next)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node)!, indexByNode.get(next)!));
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }
    const component: string[] = [];
    let current: string | undefined;
    do {
      current = stack.pop();
      if (!current) {
        throw new Error("Import cycle stack underflow");
      }
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
      components.push(component.toSorted((left, right) => left.localeCompare(right)));
    }
  };

  for (const node of graph.keys()) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components.toSorted(
    (left, right) =>
      right.length - left.length || cycleSignature(left).localeCompare(cycleSignature(right)),
  );
}

function findCycleWitness(
  component: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
): string[] {
  const componentSet = new Set(component);
  const start = component[0];
  if (!start) {
    return [];
  }
  const activePath: string[] = [];
  const visited = new Set<string>();
  const visit = (node: string): string[] | null => {
    activePath.push(node);
    visited.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!componentSet.has(next)) {
        continue;
      }
      const existingIndex = activePath.indexOf(next);
      if (existingIndex >= 0) {
        return [...activePath.slice(existingIndex), next];
      }
      if (!visited.has(next)) {
        const result = visit(next);
        if (result) {
          return result;
        }
      }
    }
    activePath.pop();
    return null;
  };
  return visit(start) ?? [...component];
}

export function formatCycle(
  component: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
): string {
  const witness = findCycleWitness(component, graph);
  return witness.map((file, index) => `${index === 0 ? "  " : "  -> "}${file}`).join("\n");
}
