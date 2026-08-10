#!/usr/bin/env node
// Codemod Move script supports OpenClaw repository automation.
// Manifest-driven file moves for the structure refactor: `git mv` plus relative
// import/export specifier rewriting plus a textual sweep of build/config files
// that name moved paths. Manifests live in scripts/moves/<step>.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectSourceFiles } from "./import-cycle-graph.ts";

export type Move = { readonly from: string; readonly to: string };

/** Roots whose source files get their relative specifiers rewritten. */
export const rewriteRoots = ["src", "extensions", "packages", "scripts", "test", "ui"] as const;

/** Extensions treated as rewritable source. */
export const sourceExtensions = [".ts", ".tsx", ".mts", ".mjs", ".js"] as const;

// Resolution candidates mirror createSourceResolver() in
// scripts/check-import-cycles.ts — that function owns the canonical
// specifier->file mapping for this repo (NodeNext writes `.js` for a `.ts`
// file). Kept in sync by hand because it is not exported from the shared lib.
const resolutionExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const specifierExtensionByFileExtension = new Map([
  [".ts", ".js"],
  [".tsx", ".jsx"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
]);

// `state/` is only ignored at the repo root (runtime data); `src/state/` is real source.
const ignoredPathPartPattern =
  /(^|\/)(node_modules|dist|dist-runtime|build|coverage|\.artifacts|\.git|assets)(\/|$)|^state(\/|$)/;

// Tests and declarations are excluded from the dangling-specifier audit for the
// same reason check-import-cycles.ts skips them: test files embed synthetic
// import statements inside string fixtures that point at temp dirs, so a text
// scanner cannot tell them from real edges. The leftover-path half of the audit
// still covers every source file.
const auditSkipPattern =
  /(?:\.test|\.e2e\.test|\.test-helpers|\.test-support)\.[cm]?[tj]sx?$|\.d\.[cm]?ts$/;

/** Sibling suffixes that must travel with `X.ts` when it moves. */
const siblingSuffixes = [".test.ts", ".test-helpers.ts", ".test-support.ts"] as const;

// `from "x"`, `import "x"`, `import("x")`, `export ... from "x"`, `require("x")`.
const specifierPattern = /\b(from|import|require)(\s*\(\s*|\s*)(["'])([^"'\n]*)\3/g;

// Mock-registry and dynamic-actual specifiers. These take a module specifier in
// the same coordinate system as an import but never appear after `from`/`import`,
// so the import scanner misses them — and they live overwhelmingly in files that
// are not themselves moving. An `importActual` call may carry a type argument
// between the method name and the paren, and that argument routinely wraps a
// nested dynamic import of the same module (one level of `<>` nesting is
// tolerated).
const mockSpecifierPattern =
  /\b(vi|vitest|jest)\.(mock|doMock|unmock|doUnmock|importActual|importMock)(\s*<(?:[^<>]|<[^<>]*>)*>)?(\s*\(\s*)(["'])([^"'\n]*)\5/g;

// Bare string literals, used only for the moved-file audit. The backtick branch
// comes second on purpose: a template literal is consumed whole, so quotes nested
// inside an interpolation are never scanned separately, and the whole template is
// dropped when it carries `${` (its value is not knowable statically).
const literalScanPattern = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^\\`])*)`/g;

// Repo-root-relative path tokens (`src/infra/exec.ts`), optionally carrying the
// same `./`/`../` prefix run that referencePattern() preserves. The token class
// stops at anything a path cannot contain, so `src/infra/exec.ts:12` and
// `${x}/src/infra/exec.ts` both yield the bare path.
const rootRelativePathPattern = new RegExp(
  String.raw`(?<![\w.\-/])((?:\.{1,2}/)*)((?:${rewriteRoots.join("|")})/[\w.\-/]+)`,
  "g",
);

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function shouldSkipRepoPath(repoPath: string): boolean {
  return ignoredPathPartPattern.test(repoPath);
}

function mapToSpecifierPath(repoPath: string): string {
  const extension = path.posix.extname(repoPath);
  const mapped = specifierExtensionByFileExtension.get(extension);
  return mapped ? `${repoPath.slice(0, -extension.length)}${mapped}` : repoPath;
}

function relativeSpecifier(fromDir: string, targetPath: string): string {
  const relative = path.posix.relative(fromDir, targetPath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** Splits `./x.js?scope=1` into its path and its query/hash tail. */
function splitLiteralQuery(literal: string): { readonly pathPart: string; readonly tail: string } {
  const index = literal.search(/[?#]/);
  return index === -1
    ? { pathPart: literal, tail: "" }
    : { pathPart: literal.slice(0, index), tail: literal.slice(index) };
}

// Deliberately narrow: a literal only enters the moved-file audit if it looks
// like a concrete relative path. Bare `.`/`..`, directory-ish trailers, globs,
// interpolation and anything with whitespace are dropped so the warning list
// stays readable on a 30-file manifest.
function isAuditableRelativeLiteral(literal: string): boolean {
  if (!literal.startsWith("./") && !literal.startsWith("../")) {
    return false;
  }
  if (literal.includes("${") || literal.includes("*") || /\s/.test(literal)) {
    return false;
  }
  const { pathPart } = splitLiteralQuery(literal);
  return pathPart.length > 0 && !pathPart.endsWith("/") && pathPart !== "." && pathPart !== "..";
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * `src/infra/exec.ts` -> `src/infra/exec/exec.ts` turns the extension-stripped
 * stem `src/infra/exec` into a directory. Matching that stem textually would
 * rewrite — and in `--check`, flag — every legitimate reference to the new
 * directory, so the stem variant is dropped once it names one. The disk probe
 * covers a post-apply run; the manifest probe covers `--dry-run`, where the
 * directory does not exist yet.
 */
function namesDirectoryPostMove(
  repoRoot: string,
  variant: string,
  moves: readonly Move[],
): boolean {
  const absolute = path.join(repoRoot, variant);
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    return true;
  }
  return moves.some((move) => move.to.startsWith(`${variant}/`));
}

type VariantPair = { readonly from: string; readonly to: string };

/**
 * The textual spellings of one move, paired old -> new. Variants that name a
 * post-move directory are dropped; see {@link namesDirectoryPostMove}.
 */
function movePathVariantPairs(repoRoot: string, move: Move, moves: readonly Move[]): VariantPair[] {
  const fromVariants = pathVariants(move.from);
  const toVariants = pathVariants(move.to);
  return fromVariants
    .map((from, index) => ({ from, to: toVariants[index] ?? from }))
    .filter(({ from }) => !namesDirectoryPostMove(repoRoot, from, moves));
}

/**
 * Rewrites repo-root-relative path literals (`"src/infra/exec.ts"`) onto their
 * manifest targets. Cold-import tests, boundary tests and doc strings name files
 * this way, and such a literal identifies a moved file exactly as precisely as an
 * import specifier does — the `--check` audit already fails on the leftovers, so
 * the rewriter closes the loop instead of leaving them for a human.
 *
 * Variants are registered longest-first so that when two manifest entries claim
 * the same spelling (an `X.ts` and an `X.js` moving to different homes), the
 * longer, more specific source path wins.
 */
function createRootRelativeRewriter(
  repoRoot: string,
  moves: readonly Move[],
): (text: string, baseOffset: number, isProtected: (offset: number) => boolean) => string {
  const pairs: Array<{ from: string; to: string; sourceLength: number }> = [];
  for (const move of moves) {
    for (const pair of movePathVariantPairs(repoRoot, move, moves)) {
      pairs.push({ from: pair.from, to: pair.to, sourceLength: move.from.length });
    }
  }
  pairs.sort((a, b) => b.from.length - a.from.length || b.sourceLength - a.sourceLength);
  const replacementByVariant = new Map<string, string>();
  for (const pair of pairs) {
    if (!replacementByVariant.has(pair.from)) {
      replacementByVariant.set(pair.from, pair.to);
    }
  }
  return (text, baseOffset, isProtected) =>
    text.replaceAll(
      rootRelativePathPattern,
      (match, prefix: string, token: string, offset: number) => {
        const replacement = replacementByVariant.get(token);
        if (replacement === undefined || isProtected(baseOffset + offset)) {
          return match;
        }
        return `${prefix}${replacement}`;
      },
    );
}

/**
 * Absolute `[start, end)` spans of quote-delimited runs nested *inside* another
 * string literal. Test files build synthetic modules as text before writing them
 * to a temp dir — a re-export statement quoted inside a single-quoted string — and
 * those inner specifiers live in the temp dir's coordinates, not this repo's. The
 * import scanner cannot tell them apart on its own, so the rewriter consults these
 * spans and leaves them alone.
 */
function collectNestedQuoteSpans(content: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (const outer of content.matchAll(literalScanPattern)) {
    const innerStart = outer.index + 1;
    for (const nested of outer[0].slice(1, -1).matchAll(literalScanPattern)) {
      spans.push([innerStart + nested.index, innerStart + nested.index + nested[0].length]);
    }
  }
  return spans;
}

export function collectRewritableSourceFiles(repoRoot: string): string[] {
  return rewriteRoots.flatMap((root) => {
    const absolute = path.join(repoRoot, root);
    if (!existsSync(absolute)) {
      return [];
    }
    return collectSourceFiles(absolute, { repoRoot, sourceExtensions, shouldSkipRepoPath });
  });
}

function createSpecifierResolver(files: readonly string[]) {
  const fileSet = new Set(files);
  const pathMap = new Map<string, string>();
  const declarationPattern = /\.d\.([cm]?)ts$/;
  for (const file of files) {
    if (declarationPattern.test(file)) {
      continue;
    }
    const parsed = path.posix.parse(file);
    const extensionless = path.posix.join(parsed.dir, parsed.name);
    pathMap.set(extensionless, file);
    const specifierExtension = specifierExtensionByFileExtension.get(parsed.ext);
    if (specifierExtension) {
      pathMap.set(`${extensionless}${specifierExtension}`, file);
    }
  }
  // Second pass: `foo.generated.d.ts` backs a `foo.generated.js` emitted at build
  // time, so declarations satisfy specifiers no real source already claims.
  for (const file of files) {
    const declarationMatch = declarationPattern.exec(file);
    if (!declarationMatch) {
      continue;
    }
    const stem = file.slice(0, -`.d.${declarationMatch[1]}ts`.length);
    for (const key of [stem, `${stem}.${declarationMatch[1]}js`]) {
      if (!pathMap.has(key)) {
        pathMap.set(key, file);
      }
    }
  }
  return (importerRepoPath: string, specifier: string): string | null => {
    // Template-literal specifiers are computed at runtime; nothing to resolve.
    if (!specifier.startsWith(".") || specifier.includes("${")) {
      return null;
    }
    const base = path.posix.normalize(
      path.posix.join(path.posix.dirname(importerRepoPath), specifier),
    );
    const candidates = [
      base,
      ...resolutionExtensions.map((extension) => `${base}${extension}`),
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

export function parseManifest(json: string): Move[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("Manifest must be a JSON array of { from, to } entries.");
  }
  return parsed.map((entry, index) => {
    const record = entry as { from?: unknown; to?: unknown };
    if (typeof record.from !== "string" || typeof record.to !== "string") {
      throw new Error(`Manifest entry ${index} needs string "from" and "to" paths.`);
    }
    return { from: toPosix(record.from), to: toPosix(record.to) };
  });
}

export function invertManifest(moves: readonly Move[]): Move[] {
  return moves.map((move) => ({ from: move.to, to: move.from }));
}

export function validateMoves(repoRoot: string, moves: readonly Move[]): string[] {
  const errors: string[] = [];
  const seenFrom = new Set<string>();
  const seenTo = new Set<string>();
  const manifestFroms = new Set(moves.map((move) => move.from));

  for (const move of moves) {
    if (!existsSync(path.join(repoRoot, move.from))) {
      errors.push(`missing source: ${move.from}`);
    }
    if (existsSync(path.join(repoRoot, move.to))) {
      errors.push(`target already exists: ${move.to}`);
    }
    if (seenFrom.has(move.from)) {
      errors.push(`duplicate source: ${move.from}`);
    }
    if (seenTo.has(move.to)) {
      errors.push(`duplicate target: ${move.to}`);
    }
    seenFrom.add(move.from);
    seenTo.add(move.to);
  }

  // A module and its colocated test/helper files must move together, otherwise
  // the test lane keeps a file whose subject vanished. The orchestrator fixes
  // the manifest; this never auto-adds entries.
  const missingSiblings: string[] = [];
  for (const move of moves) {
    if (!move.from.endsWith(".ts") || siblingSuffixes.some((s) => move.from.endsWith(s))) {
      continue;
    }
    const stem = move.from.slice(0, -".ts".length);
    for (const suffix of siblingSuffixes) {
      const sibling = `${stem}${suffix}`;
      if (existsSync(path.join(repoRoot, sibling)) && !manifestFroms.has(sibling)) {
        missingSiblings.push(`${sibling} (sibling of ${move.from})`);
      }
    }
  }
  if (missingSiblings.length > 0) {
    errors.push(
      `manifest is missing colocated siblings; add them explicitly:\n  ${missingSiblings.join("\n  ")}`,
    );
  }
  return errors;
}

export type FileRewrite = { readonly file: string; readonly count: number };

export type RewritePlan = {
  readonly rewrites: FileRewrite[];
  readonly contentByFile: Map<string, string>;
  /**
   * Relative-looking literals in moved files that resolved from the old location
   * but not from the new one and could not be re-based deterministically —
   * runtime-resolved specifiers (`importFreshModule`, `new URL`) and friends.
   * Never auto-rewritten; a human decides.
   */
  readonly warnings: string[];
};

type Resolver = (importerRepoPath: string, specifier: string) => string | null;

/**
 * Resolves a specifier, falling back to a plain disk probe. Assets (JSON,
 * fixtures) sit outside the source resolver but are exactly what
 * `new URL("./x.json", import.meta.url)` names; they never appear in a manifest,
 * so their repo path is identical before and after a move and one probe is valid
 * in both coordinate systems.
 */
function probeOnDisk(
  repoRoot: string,
  resolver: Resolver,
  importerRepoPath: string,
  specifier: string,
): string | null {
  const resolved = resolver(importerRepoPath, specifier);
  if (resolved) {
    return resolved;
  }
  const direct = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerRepoPath), specifier),
  );
  return existsSync(path.join(repoRoot, direct)) ? direct : null;
}

/**
 * Decides what a relative literal should say after the move. Two cases are
 * deterministic enough to rewrite: the literal names a manifest entry, so the
 * target itself moved and the new path is known exactly; or the importer moved
 * and the literal names a file that stayed put, so only the relative base
 * changed. The first case holds in any file — a literal landing on a manifest
 * entry is no more ambiguous than an import specifier landing on one — while the
 * second is meaningful only when the importer moved. Anything else is a warning.
 */
function planLiteralRebase(
  literal: string,
  context: {
    readonly repoRoot: string;
    readonly oldPath: string;
    readonly newPath: string;
    readonly moveByFrom: ReadonlyMap<string, string>;
    readonly resolvePre: Resolver;
    readonly resolvePost: Resolver;
  },
): { readonly next?: string; readonly warning?: boolean } {
  const probe = (resolver: Resolver, importer: string, specifier: string): string | null =>
    probeOnDisk(context.repoRoot, resolver, importer, specifier);

  const { pathPart, tail } = splitLiteralQuery(literal);
  const preTarget = probe(context.resolvePre, context.oldPath, pathPart);
  if (!preTarget) {
    // Never resolved from the old location either: not something the move broke.
    return {};
  }
  const expected = context.moveByFrom.get(preTarget) ?? preTarget;
  if (probe(context.resolvePost, context.newPath, pathPart) === expected) {
    return {};
  }

  const literalPath = path.posix.normalize(
    path.posix.join(path.posix.dirname(context.oldPath), pathPart),
  );
  const targetMoved = context.moveByFrom.has(literalPath) || context.moveByFrom.has(preTarget);
  if (!targetMoved && context.oldPath === context.newPath) {
    // The importer stayed put and so did the target: re-basing has nothing to
    // fix, and touching an arbitrary literal here would be a guess.
    return {};
  }

  // Prefer re-basing the literal's own path so its surface form (a `.ts`
  // extension, an extensionless stem) survives; fall back to the resolved file
  // only when the literal spelled the target indirectly.
  let rebased = context.moveByFrom.get(literalPath);
  if (!rebased) {
    rebased = context.moveByFrom.has(preTarget)
      ? mapToSpecifierPath(context.moveByFrom.get(preTarget)!)
      : literalPath;
  }
  const next = `${relativeSpecifier(path.posix.dirname(context.newPath), rebased)}${tail}`;
  if (next === literal) {
    return { warning: true };
  }
  // Only rewrite when the result demonstrably points at the same file.
  const { pathPart: nextPathPart } = splitLiteralQuery(next);
  if (probe(context.resolvePost, context.newPath, nextPathPart) !== expected) {
    return { warning: true };
  }
  return { next };
}

/**
 * Computes specifier rewrites for every source file. `applied` tells the planner
 * where the file contents currently live on disk (post-`git mv` or pre-).
 */
export function planSpecifierRewrites(
  repoRoot: string,
  moves: readonly Move[],
  options: { readonly applied: boolean },
): RewritePlan {
  const moveByFrom = new Map(moves.map((move) => [move.from, move.to]));
  const moveByTo = new Map(moves.map((move) => [move.to, move.from]));
  const onDiskFiles = collectRewritableSourceFiles(repoRoot);
  // Resolution always happens in pre-move coordinates.
  const preMoveFiles = options.applied
    ? onDiskFiles.map((file) => moveByTo.get(file) ?? file)
    : onDiskFiles;
  const postMoveFiles = options.applied
    ? onDiskFiles
    : onDiskFiles.map((file) => moveByFrom.get(file) ?? file);
  const resolve = createSpecifierResolver(preMoveFiles);
  const resolvePost = createSpecifierResolver(postMoveFiles);
  const rewriteRootRelative = createRootRelativeRewriter(repoRoot, moves);

  const rewrites: FileRewrite[] = [];
  const contentByFile = new Map<string, string>();
  const warnings: string[] = [];

  for (const diskPath of onDiskFiles) {
    const oldPath = options.applied ? (moveByTo.get(diskPath) ?? diskPath) : diskPath;
    const newPath = options.applied ? diskPath : (moveByFrom.get(diskPath) ?? diskPath);
    const importerMoved = oldPath !== newPath;
    const oldDir = path.posix.dirname(oldPath);
    const newDir = path.posix.dirname(newPath);
    const original = readFileSync(path.join(repoRoot, diskPath), "utf8");
    let count = 0;

    // The nested-string guard is scoped to the files that actually embed
    // synthetic module text — the same set the audit exempts from the import
    // scan — and is recomputed per pass because each pass shifts offsets.
    const isTestFile = auditSkipPattern.test(diskPath);
    const nestedGuard = (text: string): ((offset: number) => boolean) => {
      if (!isTestFile) {
        return () => false;
      }
      const spans = collectNestedQuoteSpans(text);
      return (offset) => spans.some(([start, end]) => offset >= start && offset < end);
    };

    /** Shared by the import and mock passes: both speak module specifiers. */
    const rewriteSpecifier = (specifier: string): string | null => {
      if (!specifier.startsWith(".")) {
        return null;
      }
      const resolved = resolve(oldPath, specifier);
      const literalOldPath = path.posix.normalize(path.posix.join(oldDir, specifier));
      // The resolver only indexes source extensions, so an import of a non-TS
      // asset (`./x.json`) resolves to nothing and would be mistaken for a
      // target that stayed put — and then depth-rebased onto the old directory.
      // The specifier spells such an asset exactly, so the manifest answers it.
      const movedTarget =
        (resolved ? moveByFrom.get(resolved) : undefined) ?? moveByFrom.get(literalOldPath);
      if (!movedTarget && !importerMoved) {
        return null;
      }
      const targetSpecifierPath = movedTarget ? mapToSpecifierPath(movedTarget) : literalOldPath;
      const next = relativeSpecifier(newDir, targetSpecifierPath);
      return next === specifier ? null : next;
    };

    // The literal pass runs first, against untouched text, because every pass
    // resolves in pre-move coordinates: once the import pass has rewritten a
    // specifier, re-resolving it as a bare literal would measure it from the old
    // directory again and "fix" a correct path into a wrong one. Literals the
    // specifier passes own are skipped here by offset, so the three passes
    // partition the file rather than overlapping.
    const claimed = new Set<number>();
    for (const [pattern, group] of [
      [specifierPattern, 4],
      [mockSpecifierPattern, 6],
    ] as const) {
      for (const match of original.matchAll(pattern)) {
        const specifier = match[group] ?? "";
        claimed.add(match.index + match[0].length - specifier.length - 2);
      }
    }
    const literalNested = nestedGuard(original);
    let updated = original.replaceAll(
      literalScanPattern,
      (match, quote: string | undefined, quoted: string | undefined, ...rest: unknown[]) => {
        const templated = rest[0] as string | undefined;
        const offset = rest[1] as number;
        const literal = quote === undefined ? templated : quoted;
        if (literal === undefined || claimed.has(offset)) {
          return match;
        }
        const requote = (next: string): string =>
          quote === undefined ? `\`${next}\`` : `${quote}${next}${quote}`;

        let pendingWarning: string | undefined;
        if (isAuditableRelativeLiteral(literal)) {
          const outcome = planLiteralRebase(literal, {
            repoRoot,
            oldPath,
            newPath,
            moveByFrom,
            resolvePre: resolve,
            resolvePost,
          });
          if (outcome.next !== undefined) {
            count += 1;
            return requote(outcome.next);
          }
          if (outcome.warning) {
            pendingWarning = `${newPath}: relative literal "${literal}" needs a hand-written fix`;
          }
        }

        // A repo-root-relative spelling is unambiguous wherever it appears, so it
        // is tried in every literal — including one the relative rebaser gave up
        // on, which is exactly the `"src/commands/agent.ts"` shape it cannot see.
        const rewritten = rewriteRootRelative(literal, offset + 1, literalNested);
        if (rewritten !== literal) {
          count += 1;
          return requote(rewritten);
        }
        if (pendingWarning !== undefined) {
          warnings.push(pendingWarning);
        }
        return match;
      },
    );

    const specifierNested = nestedGuard(updated);
    updated = updated.replaceAll(
      specifierPattern,
      (
        match,
        keyword: string,
        separator: string,
        quote: string,
        specifier: string,
        offset: number,
      ) => {
        if (specifierNested(offset + match.length - specifier.length - 2)) {
          return match;
        }
        const next = rewriteSpecifier(specifier);
        if (next === null) {
          return match;
        }
        count += 1;
        return `${keyword}${separator}${quote}${next}${quote}`;
      },
    );

    // Mocks go last, over the already-import-rewritten text, so a nested dynamic
    // import inside an `importActual` type argument is preserved as it now reads
    // rather than restored from the original.
    const mockNested = nestedGuard(updated);
    updated = updated.replaceAll(
      mockSpecifierPattern,
      (
        match,
        object: string,
        method: string,
        generic: string | undefined,
        open: string,
        quote: string,
        specifier: string,
        offset: number,
      ) => {
        if (mockNested(offset + match.length - specifier.length - 2)) {
          return match;
        }
        const next = rewriteSpecifier(specifier);
        if (next === null) {
          return match;
        }
        count += 1;
        return `${object}.${method}${generic ?? ""}${open}${quote}${next}${quote}`;
      },
    );

    if (count > 0) {
      rewrites.push({ file: newPath, count });
      contentByFile.set(diskPath, updated);
    }
  }
  return { rewrites, contentByFile, warnings };
}

function walkFiles(repoRoot: string, relativeRoot: string): string[] {
  const absolute = path.join(repoRoot, relativeRoot);
  if (!existsSync(absolute)) {
    return [];
  }
  const stats = statSync(absolute);
  if (stats.isFile()) {
    return [toPosix(relativeRoot)];
  }
  if (!stats.isDirectory() || shouldSkipRepoPath(toPosix(relativeRoot))) {
    return [];
  }
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    walkFiles(repoRoot, path.posix.join(toPosix(relativeRoot), entry.name)),
  );
}

/** Build/config files that name source paths textually rather than importing them. */
export function collectSweepTargets(repoRoot: string): string[] {
  const targets = new Set<string>();
  for (const file of walkFiles(repoRoot, ".")) {
    const base = path.posix.basename(file);
    if (/^tsconfig.*\.json$/.test(base)) {
      targets.add(file);
    }
  }
  for (const file of walkFiles(repoRoot, "config")) {
    targets.add(file);
  }
  for (const file of walkFiles(repoRoot, "test/vitest")) {
    if (file.endsWith(".ts")) {
      targets.add(file);
    }
  }
  for (const file of walkFiles(repoRoot, "scripts")) {
    if (file.endsWith(".mjs")) {
      targets.add(file);
    }
  }
  for (const file of ["tsdown.config.ts", "vitest.config.ts", "package.json", ".oxlintrc.json"]) {
    if (existsSync(path.join(repoRoot, file))) {
      targets.add(file);
    }
  }
  return [...targets].filter((file) => existsSync(path.join(repoRoot, file))).toSorted();
}

function pathVariants(repoPath: string): string[] {
  const extension = path.posix.extname(repoPath);
  const stem = extension ? repoPath.slice(0, -extension.length) : repoPath;
  const specifierExtension = specifierExtensionByFileExtension.get(extension);
  const variants = [repoPath];
  if (specifierExtension) {
    variants.push(`${stem}${specifierExtension}`);
  }
  variants.push(stem);
  return variants;
}

// A leading `./` or `../` run is captured so nested tsconfigs keep their prefix.
function referencePattern(repoPath: string): RegExp {
  return new RegExp(
    String.raw`(?<![\w.\-/])((?:\.{1,2}/)*)${escapeRegExp(repoPath)}(?![\w.\-/])`,
    "g",
  );
}

export function planReferenceSweep(
  repoRoot: string,
  moves: readonly Move[],
): { readonly sweeps: FileRewrite[]; readonly contentByFile: Map<string, string> } {
  const sweeps: FileRewrite[] = [];
  const contentByFile = new Map<string, string>();
  for (const file of collectSweepTargets(repoRoot)) {
    const original = readFileSync(path.join(repoRoot, file), "utf8");
    let content = original;
    let count = 0;
    for (const move of moves) {
      for (const pair of movePathVariantPairs(repoRoot, move, moves)) {
        content = content.replaceAll(referencePattern(pair.from), (_match, prefix: string) => {
          count += 1;
          return `${prefix}${pair.to}`;
        });
      }
    }
    if (count > 0 && content !== original) {
      sweeps.push({ file, count });
      contentByFile.set(file, content);
    }
  }
  return { sweeps, contentByFile };
}

export type MoveOutcome = {
  readonly moved: Move[];
  readonly rewrites: FileRewrite[];
  readonly sweeps: FileRewrite[];
  readonly warnings: string[];
};

export function applyMoves(
  repoRoot: string,
  moves: readonly Move[],
  options: { readonly dryRun?: boolean } = {},
): MoveOutcome {
  const errors = validateMoves(repoRoot, moves);
  if (errors.length > 0) {
    throw new Error(`Manifest validation failed:\n  ${errors.join("\n  ")}`);
  }
  if (options.dryRun) {
    const plan = planSpecifierRewrites(repoRoot, moves, { applied: false });
    const sweep = planReferenceSweep(repoRoot, moves);
    return {
      moved: [...moves],
      rewrites: plan.rewrites,
      sweeps: sweep.sweeps,
      warnings: plan.warnings,
    };
  }

  for (const move of moves) {
    mkdirSync(path.dirname(path.join(repoRoot, move.to)), { recursive: true });
    execFileSync("git", ["mv", move.from, move.to], { cwd: repoRoot, stdio: "pipe" });
  }

  const plan = planSpecifierRewrites(repoRoot, moves, { applied: true });
  for (const [file, content] of plan.contentByFile) {
    writeFileSync(path.join(repoRoot, file), content);
  }
  const sweep = planReferenceSweep(repoRoot, moves);
  for (const [file, content] of sweep.contentByFile) {
    writeFileSync(path.join(repoRoot, file), content);
  }
  return {
    moved: [...moves],
    rewrites: plan.rewrites,
    sweeps: sweep.sweeps,
    warnings: plan.warnings,
  };
}

export type AuditResult = { readonly failures: string[]; readonly warnings: string[] };

/**
 * Post-apply audit: every relative specifier must resolve, no source file may
 * still name a manifest `from` path textually, and every moved file's remaining
 * relative literals must still point somewhere.
 */
export function auditMoves(repoRoot: string, moves: readonly Move[]): AuditResult {
  const files = collectRewritableSourceFiles(repoRoot);
  const moveByTo = new Map(moves.map((move) => [move.to, move.from]));
  const moveByFrom = new Map(moves.map((move) => [move.from, move.to]));
  const resolve = createSpecifierResolver(files);
  const resolvePre = createSpecifierResolver(files.map((file) => moveByTo.get(file) ?? file));
  const failures: string[] = [];
  const warnings: string[] = [];

  const reportDangling = (file: string, specifier: string): void => {
    if (!specifier.startsWith(".") || specifier.includes("${")) {
      return;
    }
    if (resolve(file, specifier)) {
      return;
    }
    // Non-source targets (JSON, assets) are legitimate: fall back to disk.
    const direct = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (existsSync(path.join(repoRoot, direct))) {
      return;
    }
    failures.push(`${file}: dangling specifier "${specifier}"`);
  };

  for (const file of files) {
    const content = readFileSync(path.join(repoRoot, file), "utf8");
    // Same exemption the rewriter honors: a moved path spelled inside a string
    // that is itself inside a string is fixture text for a temp dir, so flagging
    // it would report a leftover the codemod correctly declined to touch.
    const nestedSpans = auditSkipPattern.test(file) ? collectNestedQuoteSpans(content) : [];
    const isNested = (offset: number): boolean =>
      nestedSpans.some(([start, end]) => offset >= start && offset < end);
    // Import statements inside test files stay exempt (synthetic fixture imports
    // point at temp dirs), but a mock specifier is always a real module edge, so
    // it is scanned everywhere.
    for (const match of auditSkipPattern.test(file) ? [] : content.matchAll(specifierPattern)) {
      reportDangling(file, match[4] ?? "");
    }
    // Mock specifiers are scanned in every file, tests included: unlike an import
    // statement they are never part of a synthetic fixture, so the exemption above
    // does not apply. The check is deliberately narrow — a mock pointing at a
    // manifest `from` is a leftover reference to a moved path, which is this
    // audit's job; a mock pointing at some unrelated missing module is
    // pre-existing rot and not something a move introduced.
    for (const match of content.matchAll(mockSpecifierPattern)) {
      const specifier = match[6] ?? "";
      const preTarget = specifier.startsWith(".") ? resolvePre(file, specifier) : null;
      if (preTarget !== null && moveByFrom.has(preTarget)) {
        failures.push(`${file}: still references moved path "${preTarget}" (mock specifier)`);
      }
    }
    for (const move of moves) {
      for (const pair of movePathVariantPairs(repoRoot, move, moves)) {
        for (const match of content.matchAll(referencePattern(pair.from))) {
          if (isNested(match.index + (match[1] ?? "").length)) {
            continue;
          }
          failures.push(`${file}: still references moved path "${pair.from}"`);
          break;
        }
      }
    }

    // A relative-looking literal that named a real file from the old location
    // but names nothing from the new one is a runtime-resolved specifier the
    // rewriter could not prove safe to touch. Both halves matter — test fixtures
    // are full of synthetic relative paths (`"./config/x.json5"` under a temp
    // dir) that resolved from neither location and are not warnings. Unmoved
    // files are audited too: their literals can point at a target that moved.
    const oldPath = moveByTo.get(file) ?? file;
    for (const match of content.matchAll(literalScanPattern)) {
      const literal = match[1] === undefined ? match[3] : match[2];
      if (literal === undefined || !isAuditableRelativeLiteral(literal)) {
        continue;
      }
      const { pathPart } = splitLiteralQuery(literal);
      if (probeOnDisk(repoRoot, resolve, file, pathPart)) {
        continue;
      }
      if (!probeOnDisk(repoRoot, resolvePre, oldPath, pathPart)) {
        continue;
      }
      warnings.push(`${file}: relative literal "${literal}" resolved before the move, not after`);
    }
  }
  return { failures, warnings };
}

/** Failure-only view of {@link auditMoves}, for callers that gate on exit code. */
export function checkMoves(repoRoot: string, moves: readonly Move[]): string[] {
  return auditMoves(repoRoot, moves).failures;
}

function formatRewrites(label: string, entries: readonly FileRewrite[], cap = 25): string[] {
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const lines = [`${label}: ${total} in ${entries.length} file(s)`];
  for (const entry of entries.slice(0, cap)) {
    lines.push(`  ${entry.file} (${entry.count})`);
  }
  if (entries.length > cap) {
    lines.push(`  ... ${entries.length - cap} more file(s)`);
  }
  return lines;
}

function formatWarnings(warnings: readonly string[], cap = 40): string[] {
  if (warnings.length === 0) {
    return [];
  }
  const lines = [`unresolved relative literals in moved files: ${warnings.length} (review these)`];
  for (const warning of warnings.slice(0, cap)) {
    lines.push(`  ${warning}`);
  }
  if (warnings.length > cap) {
    lines.push(`  ... ${warnings.length - cap} more`);
  }
  return lines;
}

export function runCli(argv: readonly string[], repoRoot: string): number {
  const modes = ["--apply", "--dry-run", "--check", "--invert"] as const;
  const flag = argv.find((arg) => (modes as readonly string[]).includes(arg)) ?? "--apply";
  const manifestPath = argv.find((arg) => !arg.startsWith("--"));
  if (!manifestPath) {
    console.error("usage: codemod-move.ts [--apply|--dry-run|--check|--invert] <manifest.json>");
    return 2;
  }
  const moves = parseManifest(readFileSync(path.resolve(repoRoot, manifestPath), "utf8"));

  if (flag === "--invert") {
    console.log(JSON.stringify(invertManifest(moves), null, 2));
    return 0;
  }
  if (flag === "--check") {
    const { failures, warnings } = auditMoves(repoRoot, moves);
    for (const line of formatWarnings(warnings)) {
      console.warn(line);
    }
    if (failures.length === 0) {
      console.log(`Codemod check: OK (${moves.length} move(s) audited).`);
      return 0;
    }
    console.error(`Codemod check: ${failures.length} failure(s):`);
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    return 1;
  }

  const dryRun = flag === "--dry-run";
  let outcome: MoveOutcome;
  try {
    outcome = applyMoves(repoRoot, moves, { dryRun });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`${dryRun ? "[dry-run] " : ""}files moved: ${outcome.moved.length}`);
  for (const move of outcome.moved) {
    console.log(`  ${move.from} -> ${move.to}`);
  }
  for (const line of formatRewrites(
    `${dryRun ? "[dry-run] " : ""}specifiers rewritten`,
    outcome.rewrites,
  )) {
    console.log(line);
  }
  console.log(`${dryRun ? "[dry-run] " : ""}non-source files touched (review these):`);
  for (const sweep of outcome.sweeps) {
    console.log(`  ${sweep.file} (${sweep.count})`);
  }
  for (const line of formatWarnings(outcome.warnings)) {
    console.warn(`${dryRun ? "[dry-run] " : ""}${line}`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith("codemod-move.ts");
if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2), path.resolve(import.meta.dirname, "../.."));
}
