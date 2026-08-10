/**
 * Transport-wide constants and the subsystem logger.
 *
 * A leaf module by design: every other transport fragment reads from it and it
 * reads from nothing, which is what keeps the fragments free of a cycle through
 * the stream entry.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";

export const DEFAULT_AZURE_OPENAI_API_VERSION = "preview";
export const OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT = " ";
export const OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS = "Follow the user request.";
export const GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP = "skip_thought_signature_validator";
export const AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS = 30_000;
export const MODEL_STREAM_COOPERATIVE_YIELD_INTERVAL_MS = 12;
export const MODEL_STREAM_COOPERATIVE_YIELD_MAX_EVENTS = 64;
export const RESPONSE_FAILED_NO_DETAILS_MESSAGE = "Unknown error (no error details in response)";
export const MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS = 256;
export const OPENAI_RESPONSES_REASONING_REPLAY_META_KEY = "__openclaw_replay";
export const OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY = "openclawReasoningReplay";
export const OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH = 64;
export const OPENAI_CODEX_RESPONSES_PROVIDERS = new Set(["openai"]);
export const log = createSubsystemLogger("openai-transport");
export const loggedOpenAIStrictToolDowngradeDiagnosticKeys = new Set<string>();
