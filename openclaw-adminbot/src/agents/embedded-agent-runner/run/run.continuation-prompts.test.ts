// Characterization coverage for the continuation-prompt text extracted from run.ts.
import { describe, expect, it } from "vitest";
import {
  BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX,
  buildBeforeAgentFinalizeRetryPrompt,
  COMPACTION_CONTINUATION_RETRY_INSTRUCTION,
  MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
  MID_TURN_PRECHECK_CONTINUATION_PROMPT,
} from "./run.continuation-prompts.js";

describe("buildBeforeAgentFinalizeRetryPrompt", () => {
  it("puts the revision reason under the prefix, separated by a blank line", () => {
    expect(buildBeforeAgentFinalizeRetryPrompt("cite the source")).toBe(
      `${BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX}\n\ncite the source`,
    );
  });

  it("keeps the prefix even when the reason is empty", () => {
    expect(buildBeforeAgentFinalizeRetryPrompt("")).toBe(
      `${BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX}\n\n`,
    );
  });
});

describe("continuation prompt constants", () => {
  it("each tells the model to continue rather than restart", () => {
    expect(MID_TURN_PRECHECK_CONTINUATION_PROMPT).toContain("Continue from the current transcript");
    expect(MID_TURN_PRECHECK_CONTINUATION_PROMPT).toContain("do not rerun completed tools");
    expect(COMPACTION_CONTINUATION_RETRY_INSTRUCTION).toContain(
      "Continue from the compacted transcript",
    );
    expect(COMPACTION_CONTINUATION_RETRY_INSTRUCTION).toContain("Do not restart from scratch");
    expect(BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX).toContain("Do not repeat completed work");
  });

  it("bounds before-agent-finalize revisions so a hook cannot loop forever", () => {
    expect(MAX_BEFORE_AGENT_FINALIZE_REVISIONS).toBe(3);
  });
});
