// Characterization coverage for the initial model / think-level resolution extracted from run.ts.
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../defaults.js";
import { resolveInitialEmbeddedRunModel, resolveInitialThinkLevel } from "./run.model-selection.js";

describe("resolveInitialEmbeddedRunModel", () => {
  it("takes an explicit provider+model pair verbatim, without touching config", () => {
    expect(
      resolveInitialEmbeddedRunModel({
        config: undefined,
        provider: "anthropic",
        model: "some-model",
      }),
    ).toEqual({ provider: "anthropic", modelId: "some-model" });
  });

  it("keeps an explicit provider even when only the model was aliased", () => {
    expect(
      resolveInitialEmbeddedRunModel({ config: {}, provider: "openai", model: "gpt-x" }).provider,
    ).toBe("openai");
  });

  it("passes a bare model string through unchanged when no alias matches", () => {
    expect(resolveInitialEmbeddedRunModel({ config: {}, model: "unaliased-model" }).modelId).toBe(
      "unaliased-model",
    );
  });

  it("falls back to the built-in provider and model with no config and no request", () => {
    expect(resolveInitialEmbeddedRunModel({ config: {} })).toEqual({
      provider: DEFAULT_PROVIDER,
      modelId: DEFAULT_MODEL,
    });
  });

  it("treats a blank provider or model as absent", () => {
    expect(resolveInitialEmbeddedRunModel({ config: {}, provider: "  ", model: "  " })).toEqual({
      provider: DEFAULT_PROVIDER,
      modelId: DEFAULT_MODEL,
    });
  });
});

describe("resolveInitialThinkLevel", () => {
  it("returns the requested level unchanged, without consulting the default policy", () => {
    expect(
      resolveInitialThinkLevel({
        requested: "high",
        config: undefined,
        provider: "anthropic",
        modelId: "m",
        model: { reasoning: false },
      }),
    ).toBe("high");
  });

  it("derives a level from the thinking default when none was requested", () => {
    const level = resolveInitialThinkLevel({
      config: {},
      provider: "anthropic",
      modelId: "m",
      model: { reasoning: true },
    });
    expect(typeof level).toBe("string");
  });
});
