// Layering check tests cover domain extraction and rule evaluation on a fixture graph.
import { describe, expect, it } from "vitest";
import {
  collectDomainEdges,
  domainForRepoPath,
  evaluateLayering,
  parseLayeringConfig,
  rootDomain,
  type LayeringConfig,
} from "../../scripts/check-layering.ts";

function createConfig(overrides: Partial<LayeringConfig> = {}): LayeringConfig {
  return {
    rules: {
      applicationLayer: { domains: ["agents"] },
      portSurface: {
        domains: ["plugin-sdk"],
        forbiddenTargets: ["gateway", "cli", "commands"],
        grandfathered: [],
      },
      leaf: { domains: ["shared"], allowedTargets: ["shared", rootDomain], mode: "fail" },
      ...overrides.rules,
    },
    frozenEdges: overrides.frozenEdges ?? [],
  };
}

describe("domainForRepoPath", () => {
  it("takes the first segment under src/ and names src-root files", () => {
    expect(domainForRepoPath("src/agents/run.ts")).toBe("agents");
    expect(domainForRepoPath("src/agents/transport/stream.ts")).toBe("agents");
    expect(domainForRepoPath("src/entry.ts")).toBe(rootDomain);
  });

  it("ignores paths outside src/", () => {
    expect(domainForRepoPath("extensions/adminbot/src/api.ts")).toBeNull();
    expect(domainForRepoPath("scripts/check.mjs")).toBeNull();
    expect(domainForRepoPath("srcish/thing.ts")).toBeNull();
  });
});

describe("collectDomainEdges", () => {
  it("aggregates file imports into counted domain edges and keeps a sample", () => {
    const edges = collectDomainEdges(
      new Map([
        ["src/agents/run.ts", ["src/config/load.ts", "src/config/types.ts"]],
        ["src/agents/other.ts", ["src/config/load.ts"]],
        ["src/config/load.ts", []],
      ]),
    );

    expect(edges).toStrictEqual([
      {
        key: "agents->config",
        from: "agents",
        to: "config",
        count: 3,
        sample: { from: "src/agents/run.ts", to: "src/config/load.ts" },
      },
    ]);
  });

  it("drops self-edges and edges that leave src/", () => {
    const edges = collectDomainEdges(
      new Map([
        ["src/agents/run.ts", ["src/agents/helper.ts", "extensions/adminbot/src/api.ts"]],
        ["scripts/check.mjs", ["src/agents/run.ts"]],
      ]),
    );

    expect(edges).toStrictEqual([]);
  });
});

describe("evaluateLayering", () => {
  const graph = new Map([
    ["src/agents/run.ts", ["src/config/load.ts"]],
    ["src/plugin-sdk/cli-runtime.ts", ["src/cli/argv.ts"]],
    ["src/shared/util.ts", ["src/infra/env.ts"]],
  ]);

  it("passes when every edge is frozen and no directional rule fires", () => {
    const edges = collectDomainEdges(new Map([["src/agents/run.ts", ["src/config/load.ts"]]]));
    const result = evaluateLayering(edges, createConfig({ frozenEdges: ["agents->config"] }));

    expect(result.failures).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("fails an edge that is not in the frozen set", () => {
    const edges = collectDomainEdges(new Map([["src/agents/run.ts", ["src/config/load.ts"]]]));
    const result = evaluateLayering(edges, createConfig());

    expect(result.failures.map((finding) => [finding.rule, finding.edge])).toStrictEqual([
      ["frozen-edge", "agents->config"],
    ]);
  });

  it("fails a forbidden port-surface edge even when it is frozen", () => {
    const edges = collectDomainEdges(graph);
    const result = evaluateLayering(
      edges,
      createConfig({ frozenEdges: ["agents->config", "plugin-sdk->cli", "shared->infra"] }),
    );

    expect(result.failures.map((finding) => [finding.rule, finding.edge])).toStrictEqual([
      ["port-surface", "plugin-sdk->cli"],
      ["leaf", "shared->infra"],
    ]);
  });

  it("downgrades a grandfathered port-surface edge to a warning", () => {
    const config = createConfig({ frozenEdges: ["plugin-sdk->cli"] });
    config.rules.portSurface.grandfathered = ["plugin-sdk->cli"];
    const edges = collectDomainEdges(
      new Map([["src/plugin-sdk/cli-runtime.ts", ["src/cli/argv.ts"]]]),
    );
    const result = evaluateLayering(edges, config);

    expect(result.failures).toStrictEqual([]);
    expect(result.warnings.map((finding) => [finding.rule, finding.edge])).toStrictEqual([
      ["port-surface", "plugin-sdk->cli"],
    ]);
  });

  it("warns rather than fails on a leaf violation in aspirational mode", () => {
    const config = createConfig({ frozenEdges: ["shared->infra"] });
    config.rules.leaf.mode = "warn";
    const edges = collectDomainEdges(new Map([["src/shared/util.ts", ["src/infra/env.ts"]]]));
    const result = evaluateLayering(edges, config);

    expect(result.failures).toStrictEqual([]);
    expect(result.warnings.map((finding) => [finding.rule, finding.edge])).toStrictEqual([
      ["leaf", "shared->infra"],
    ]);
  });

  it("warns about frozen edges that no longer exist", () => {
    const result = evaluateLayering([], createConfig({ frozenEdges: ["agents->gone"] }));

    expect(result.failures).toStrictEqual([]);
    expect(result.warnings.map((finding) => [finding.rule, finding.edge])).toStrictEqual([
      ["prunable-frozen-edge", "agents->gone"],
    ]);
  });
});

describe("parseLayeringConfig", () => {
  it("accepts the shipped config", () => {
    const config = parseLayeringConfig(JSON.stringify(createConfig({ frozenEdges: ["a->b"] })));

    expect(config.frozenEdges).toStrictEqual(["a->b"]);
  });

  it("rejects a config that is missing the frozen edge list", () => {
    expect(() => parseLayeringConfig(JSON.stringify({ rules: {} }))).toThrow(
      /must declare a frozenEdges array/,
    );
  });

  it("rejects an unknown leaf mode", () => {
    const config = createConfig();
    const raw = JSON.stringify({
      ...config,
      rules: { ...config.rules, leaf: { ...config.rules.leaf, mode: "off" } },
    });

    expect(() => parseLayeringConfig(raw)).toThrow(/rules\.leaf\.mode/);
  });
});
