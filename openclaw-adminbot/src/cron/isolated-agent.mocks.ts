/** Shared Vitest module mocks for isolated-agent cron tests. */
import { vi } from "vitest";

vi.mock("../agents/embedded/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  runEmbeddedAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

vi.mock("../agents/models/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

vi.mock("../agents/models/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/models/model-selection.js")>(
    "../agents/models/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: vi.fn(() => false),
  };
});

vi.mock("../agents/subagents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

vi.mock("../plugins/runtime/runtime-plugins.runtime.js", () => ({
  ensureRuntimePluginsLoaded: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));
