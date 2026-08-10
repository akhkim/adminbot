import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMoves,
  checkMoves,
  invertManifest,
  parseManifest,
  validateMoves,
} from "../../scripts/lib/codemod-move.ts";

// The codemod rewrites real files with `git mv`, so every case runs against a
// throwaway git repo rather than this tree.
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function write(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function read(root: string, relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function createFixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codemod-move-"));
  temporaryDirectories.push(root);

  write(
    root,
    "src/a/alpha.ts",
    `import { beta } from "../b/beta.js";\nexport const alpha = beta;\n`,
  );
  write(root, "src/b/beta.ts", "export const beta = 1;\n");
  write(root, "src/b/beta.test.ts", `import { beta } from "./beta.js";\nexport const t = beta;\n`);
  write(
    root,
    "src/c/consumer.ts",
    [
      `export { alpha } from '../a/alpha.js';`,
      `export async function load() {`,
      `  return await import("../a/alpha.js");`,
      `}`,
      // Runtime-resolved: no import keyword in front of it, and this file is not moving.
      `export const fresh = () => importFreshModule(import.meta.url, "../a/alpha.js?scope=c");`,
      ``,
    ].join("\n"),
  );
  // A non-moving test file that mocks the moving module four different ways.
  write(
    root,
    "src/c/consumer.test.ts",
    [
      `import { vi } from "vitest";`,
      `vi.mock("../a/alpha.js", () => ({ alpha: 0 }));`,
      `vi.doMock('../a/alpha.js');`,
      `vi.doUnmock("../a/alpha.js");`,
      `vi.mock("../b/beta.js");`,
      `export async function actual() {`,
      `  return await vi.importActual<typeof import("../a/alpha.js")>("../a/alpha.js");`,
      `}`,
      ``,
    ].join("\n"),
  );
  // A moving module whose runtime-resolved literals are invisible to the import scanner.
  write(
    root,
    "src/a/runtime.ts",
    [
      `export const schema = new URL("./schema.json", import.meta.url);`,
      `export const fresh = () => importFreshModule(import.meta.url, "../b/beta.js");`,
      `export const dynamic = (label: string) => import(\`./alpha.js?scope=\${label}\`);`,
      `export const missing = "./not-a-file.js";`,
      ``,
    ].join("\n"),
  );
  write(root, "src/a/schema.json", "{}\n");
  // Repo-root-relative literals: a cold-import guard, a doc-comment-adjacent
  // message, an extension-stripped stem and an unrelated path that must survive.
  write(
    root,
    "src/c/boundary.test.ts",
    [
      `const entry = "src/a/alpha.ts";`,
      `const built = "src/a/alpha.js";`,
      `const stem = "src/a/alpha";`,
      `const other = "src/b/beta.ts";`,
      `const label = \`entry \${entry} at src/a/alpha.ts\`;`,
      // Synthetic fixture code written to a temp dir: the inner specifier and the
      // inner root-relative literal are in the temp repo's coordinate system.
      `const source = 'export * from "../a/alpha.js";';`,
      `const manifest = 'const p = "src/a/alpha.ts";';`,
      `export { entry, built, stem, other, label, source, manifest };`,
      ``,
    ].join("\n"),
  );
  write(root, "tsconfig.json", `{\n  "files": ["src/a/alpha.ts", "src/b/beta.ts"]\n}\n`);

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const alphaMove = [{ from: "src/a/alpha.ts", to: "src/agents/models/alpha.ts" }];
const runtimeMove = [{ from: "src/a/runtime.ts", to: "src/agents/models/runtime.ts" }];

describe("codemod-move", () => {
  it("rewrites specifiers in importers and in the moved file itself", () => {
    const root = createFixtureRepo();
    const outcome = applyMoves(root, alphaMove);

    expect(outcome.moved).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "src/agents/models/alpha.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src/a/alpha.ts"))).toBe(false);

    // The moved file resolves its own imports from the old location and is
    // rewritten relative to the new one.
    expect(read(root, "src/agents/models/alpha.ts")).toContain(`from "../../b/beta.js"`);
    // Importers keep their quote style, and dynamic imports are rewritten too.
    const consumer = read(root, "src/c/consumer.ts");
    expect(consumer).toContain(`from '../agents/models/alpha.js'`);
    expect(consumer).toContain(`import("../agents/models/alpha.js")`);
    // Untouched files stay untouched.
    expect(read(root, "src/b/beta.test.ts")).toContain(`from "./beta.js"`);
  });

  it("rewrites vi.mock-family specifiers in files that are not themselves moving", () => {
    const root = createFixtureRepo();
    const outcome = applyMoves(root, alphaMove);
    const spec = read(root, "src/c/consumer.test.ts");

    expect(spec).toContain(`vi.mock("../agents/models/alpha.js", () => ({ alpha: 0 }));`);
    expect(spec).toContain(`vi.doMock('../agents/models/alpha.js');`);
    expect(spec).toContain(`vi.doUnmock("../agents/models/alpha.js");`);
    // A generic type argument between the method name and the paren survives,
    // and the specifier nested inside it is rewritten too.
    expect(spec).toContain(
      `vi.importActual<typeof import("../agents/models/alpha.js")>("../agents/models/alpha.js")`,
    );
    // An unrelated mock target is left alone.
    expect(spec).toContain(`vi.mock("../b/beta.js");`);

    const consumerSpec = outcome.rewrites.find((entry) => entry.file === "src/c/consumer.test.ts");
    expect(consumerSpec?.count).toBe(5);
  });

  it("re-points a runtime literal in a non-moved file at the moved target", () => {
    const root = createFixtureRepo();
    applyMoves(root, alphaMove);

    // The importer stayed put, but its target moved, so the new path is exactly
    // as knowable as it is for an import statement. The query tail survives.
    expect(read(root, "src/c/consumer.ts")).toContain(
      `importFreshModule(import.meta.url, "../agents/models/alpha.js?scope=c")`,
    );
    // A literal in a non-moved file whose target also stayed put is never touched.
    expect(read(root, "src/b/beta.test.ts")).toContain(`from "./beta.js"`);
  });

  it("re-bases relative literals in a moved file that imports cannot reach", () => {
    const root = createFixtureRepo();
    const outcome = applyMoves(root, runtimeMove);
    const moved = read(root, "src/agents/models/runtime.ts");

    // A non-source asset that stayed put: same file, deeper relative base.
    expect(moved).toContain(`new URL("../../a/schema.json", import.meta.url)`);
    // A runtime-resolved module specifier the import scanner never sees.
    expect(moved).toContain(`importFreshModule(import.meta.url, "../../b/beta.js")`);
    // Interpolated template literals are left alone, and so are literals that
    // never resolved from the old location in the first place.
    expect(moved).toContain("`./alpha.js?scope=${label}`");
    expect(moved).toContain(`const missing = "./not-a-file.js";`);
    expect(outcome.warnings).toEqual([]);
  });

  it("rewrites an import of a non-source asset that is itself in the manifest", () => {
    const root = createFixtureRepo();
    // A JSON asset imported by its own module. The source resolver only knows
    // about TS/JS files, so without a manifest fallback the specifier looks like
    // a target that stayed put and gets depth-rebased to the old directory.
    write(
      root,
      "src/a/assets.ts",
      [
        `import table from "./table.json" with { type: "json" };`,
        `export const rows = table;`,
        ``,
      ].join("\n"),
    );
    write(root, "src/a/table.json", `{ "rows": [] }\n`);
    execFileSync("git", ["add", "-A"], { cwd: root });

    const assetMove = [
      { from: "src/a/assets.ts", to: "src/agents/models/assets.ts" },
      { from: "src/a/table.json", to: "src/agents/models/table.json" },
    ];
    applyMoves(root, assetMove);

    // Both moved into the same directory, so the specifier stays a sibling.
    expect(read(root, "src/agents/models/assets.ts")).toContain(
      `import table from "./table.json" with { type: "json" };`,
    );
    expect(checkMoves(root, assetMove)).toEqual([]);
  });

  it("rewrites repo-root-relative path literals in source files", () => {
    const root = createFixtureRepo();
    applyMoves(root, alphaMove);
    const boundary = read(root, "src/c/boundary.test.ts");

    // Every spelling of the moved file: as authored, as the emitted `.js` a
    // NodeNext specifier would name, and extension-stripped.
    expect(boundary).toContain(`const entry = "src/agents/models/alpha.ts";`);
    expect(boundary).toContain(`const built = "src/agents/models/alpha.js";`);
    expect(boundary).toContain(`const stem = "src/agents/models/alpha";`);
    // Inside a template literal too, without disturbing the interpolation.
    expect(boundary).toContain("`entry ${entry} at src/agents/models/alpha.ts`");
    // A path that is not in the manifest is left exactly as it was.
    expect(boundary).toContain(`const other = "src/b/beta.ts";`);
    // ...and the audit that used to be the only line of defense now finds
    // nothing to report.
    expect(checkMoves(root, alphaMove)).toEqual([]);
  });

  it("leaves specifiers and root-relative literals nested inside a string alone", () => {
    const root = createFixtureRepo();
    applyMoves(root, alphaMove);
    const boundary = read(root, "src/c/boundary.test.ts");

    // Synthetic module text written to a temp dir: rewriting either of these to
    // this repo's post-move layout would break the fixture.
    expect(boundary).toContain(`const source = 'export * from "../a/alpha.js";';`);
    expect(boundary).toContain(`const manifest = 'const p = "src/a/alpha.ts";';`);
    // The exemption is scoped to the fixture text, not the whole file: the
    // top-level literals in the same file were still rewritten.
    expect(boundary).toContain(`const entry = "src/agents/models/alpha.ts";`);
    // A real (non-nested) specifier in a non-test file is still rewritten.
    expect(read(root, "src/c/consumer.ts")).toContain(`from '../agents/models/alpha.js'`);
  });

  it("skips the stem variant when the move turns it into a directory", () => {
    const root = createFixtureRepo();
    // `src/b/beta` is a directory once beta.ts moves into it, so the
    // extension-stripped stem must stop matching.
    write(root, "src/c/dirref.ts", `export const dir = "src/b/beta";\n`);
    write(root, "src/c/fileref.ts", `export const file = "src/b/beta.ts";\n`);
    execFileSync("git", ["add", "-A"], { cwd: root });

    const betaMove = [
      { from: "src/b/beta.ts", to: "src/b/beta/beta.ts" },
      { from: "src/b/beta.test.ts", to: "src/b/beta/beta.test.ts" },
    ];
    applyMoves(root, betaMove);

    // The directory reference survives untouched...
    expect(read(root, "src/c/dirref.ts")).toContain(`"src/b/beta"`);
    // ...while the file reference is rebased.
    expect(read(root, "src/c/fileref.ts")).toContain(`"src/b/beta/beta.ts"`);
    // And the audit does not flag the directory reference as a leftover.
    expect(checkMoves(root, betaMove)).toEqual([]);
  });

  it("sweeps textual references in non-source config files", () => {
    const root = createFixtureRepo();
    const outcome = applyMoves(root, alphaMove);

    expect(read(root, "tsconfig.json")).toContain("src/agents/models/alpha.ts");
    expect(read(root, "tsconfig.json")).toContain("src/b/beta.ts");
    expect(outcome.sweeps.map((entry) => entry.file)).toContain("tsconfig.json");
  });

  it("reports planned work without touching anything in dry-run mode", () => {
    const root = createFixtureRepo();
    const before = read(root, "src/c/consumer.ts");
    const outcome = applyMoves(root, alphaMove, { dryRun: true });

    expect(outcome.rewrites.map((entry) => entry.file)).toContain("src/c/consumer.ts");
    expect(fs.existsSync(path.join(root, "src/a/alpha.ts"))).toBe(true);
    expect(read(root, "src/c/consumer.ts")).toBe(before);
  });

  it("requires colocated test siblings to be listed in the manifest", () => {
    const root = createFixtureRepo();
    const errors = validateMoves(root, [{ from: "src/b/beta.ts", to: "src/core/beta.ts" }]);

    expect(errors.join("\n")).toContain("src/b/beta.test.ts");
    expect(() => applyMoves(root, [{ from: "src/b/beta.ts", to: "src/core/beta.ts" }])).toThrow(
      /missing colocated siblings/,
    );

    // Listing the sibling clears the error.
    expect(
      validateMoves(root, [
        { from: "src/b/beta.ts", to: "src/core/beta.ts" },
        { from: "src/b/beta.test.ts", to: "src/core/beta.test.ts" },
      ]),
    ).toEqual([]);
  });

  it("rejects missing sources, existing targets and duplicate targets", () => {
    const root = createFixtureRepo();
    const errors = validateMoves(root, [
      { from: "src/nope.ts", to: "src/x.ts" },
      { from: "src/a/alpha.ts", to: "src/b/beta.ts" },
      { from: "src/c/consumer.ts", to: "src/x.ts" },
    ]);

    expect(errors).toContain("missing source: src/nope.ts");
    expect(errors).toContain("target already exists: src/b/beta.ts");
    expect(errors).toContain("duplicate target: src/x.ts");
  });

  it("inverts a manifest", () => {
    expect(invertManifest(parseManifest(JSON.stringify(alphaMove)))).toEqual([
      { from: "src/agents/models/alpha.ts", to: "src/a/alpha.ts" },
    ]);
  });

  it("passes --check after a clean apply and fails on a dangling specifier", () => {
    const root = createFixtureRepo();
    applyMoves(root, alphaMove);
    expect(checkMoves(root, alphaMove)).toEqual([]);

    // A specifier pointing at the old location no longer resolves...
    write(root, "src/c/dangling.ts", `export { alpha } from "../a/alpha.js";\n`);
    expect(
      checkMoves(root, alphaMove).some((failure) => failure.includes("dangling specifier")),
    ).toBe(true);

    // ...and so does a leftover textual mention of the pre-move repo path.
    write(root, "src/c/leftover.ts", `export const entry = "src/a/alpha.ts";\n`);
    expect(
      checkMoves(root, alphaMove).some((failure) =>
        failure.includes(`still references moved path "src/a/alpha.ts"`),
      ),
    ).toBe(true);
  });

  it("--check scans mock specifiers inside test files, where imports stay exempt", () => {
    const root = createFixtureRepo();
    applyMoves(root, alphaMove);
    expect(checkMoves(root, alphaMove)).toEqual([]);

    // A stale mock path in a test file still names a moved module...
    write(root, "src/c/stale.test.ts", `vi.mock("../a/alpha.js", () => ({}));\n`);
    expect(checkMoves(root, alphaMove)).toContain(
      `src/c/stale.test.ts: still references moved path "src/a/alpha.ts" (mock specifier)`,
    );

    // ...while a synthetic import statement in the same file stays exempt,
    // because test fixtures embed imports that point at temp dirs.
    write(root, "src/c/fixture.test.ts", `const source = 'import x from "../a/alpha.js";';\n`);
    expect(
      checkMoves(root, alphaMove).some((failure) => failure.startsWith("src/c/fixture.test.ts:")),
    ).toBe(false);
  });
});
