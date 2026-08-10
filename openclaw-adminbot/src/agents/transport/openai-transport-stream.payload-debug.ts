import { isRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Transport payload summaries for debug logging.
 *
 * Everything here exists to describe a request or event without reproducing it:
 * payloads are summarized to shapes and counts, and anything that reaches a log
 * goes through redaction first. Stringification never throws — a debug path that
 * can fail would turn a diagnostic into an outage.
 */
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { resolveModelPayloadDebugMode } from "../models/model-transport-debug.js";
import type { MutableAssistantOutput } from "./openai-transport-stream.types.js";

export function stringifyUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function stringifyJsonLike(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function getServiceTierCostMultiplier(
  serviceTier: ResponseCreateParamsStreaming["service_tier"],
) {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

export function applyServiceTierPricing(
  usage: MutableAssistantOutput["usage"],
  serviceTier?: ResponseCreateParamsStreaming["service_tier"],
): void {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function safeDebugValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

export function responseInputTextChars(input: unknown): number {
  if (typeof input === "string") {
    return input.length;
  }
  if (Array.isArray(input)) {
    return input.reduce((total, item) => total + responseInputTextChars(item), 0);
  }
  if (!input || typeof input !== "object") {
    return 0;
  }
  const record = input as Record<string, unknown>;
  let total = 0;
  if (typeof record.text === "string") {
    total += record.text.length;
  }
  if (typeof record.content === "string") {
    total += record.content.length;
  } else if (Array.isArray(record.content)) {
    total += responseInputTextChars(record.content);
  }
  return total;
}

export function responseInputRoles(input: unknown): string {
  if (!Array.isArray(input)) {
    return "";
  }
  const roles = new Set<string>();
  for (const item of input) {
    if (item && typeof item === "object") {
      const role = (item as Record<string, unknown>).role;
      if (typeof role === "string" && role.trim()) {
        roles.add(role.trim());
      }
    }
  }
  return [...roles].toSorted().join(",");
}

export function readToolPayloadField(record: Record<string, unknown>, field: string): unknown {
  try {
    return record[field];
  } catch {
    return undefined;
  }
}

export function readResponsesToolDisplayName(tool: unknown): string {
  if (!tool || typeof tool !== "object") {
    return "";
  }
  const record = tool as Record<string, unknown>;
  const name = readToolPayloadField(record, "name");
  if (typeof name === "string") {
    return name;
  }
  const fn = readToolPayloadField(record, "function");
  if (fn && typeof fn === "object") {
    const fnName = readToolPayloadField(fn as Record<string, unknown>, "name");
    if (typeof fnName === "string") {
      return fnName;
    }
  }
  const type = readToolPayloadField(record, "type");
  return typeof type === "string" && type !== "function" ? type : "";
}

export function summarizeResponsesTools(tools: unknown): string {
  if (!Array.isArray(tools)) {
    return "count=0";
  }
  const names = tools.map(readResponsesToolDisplayName).filter(Boolean);
  const mode = resolveModelPayloadDebugMode();
  const maxNames = mode === "tools" || mode === "full-redacted" ? names.length : 12;
  const label = maxNames >= names.length ? "names" : "sample";
  const shown = names.slice(0, maxNames).join(",");
  return `count=${tools.length}${shown ? ` ${label}=${shown}` : ""}`;
}

export function responsesPayloadToolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }
  const name = readToolPayloadField(tool, "name");
  if (typeof name === "string") {
    return name;
  }
  const fn = readToolPayloadField(tool, "function");
  if (!isRecord(fn)) {
    return undefined;
  }
  const fnName = readToolPayloadField(fn, "name");
  return typeof fnName === "string" ? fnName : undefined;
}

export function enforceCodeModeResponsesToolSurface(payload: unknown): void {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    return;
  }
  payload.tools = payload.tools.filter((tool) => {
    const name = responsesPayloadToolName(tool);
    return name === "exec" || name === "wait";
  });
}

export function assertCodeModeResponsesToolSurface(payload: unknown): void {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    throw new Error("Code mode payload tool surface violation: expected exec,wait; got no tools");
  }
  const names = payload.tools
    .map(responsesPayloadToolName)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .toSorted((a, b) => a.localeCompare(b));
  if (names.length === 2 && names[0] === "exec" && names[1] === "wait") {
    return;
  }
  throw new Error(
    `Code mode payload tool surface violation: expected exec,wait; got ${
      names.length > 0 ? names.join(",") : "none"
    }`,
  );
}

export function stringifyRedactedPayload(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) {
      return "<empty>";
    }
    const redacted = redactSensitiveText(encoded, { mode: "tools" });
    return redacted.length > 8000 ? `${redacted.slice(0, 8000)}…<truncated>` : redacted;
  } catch {
    return "<unserializable>";
  }
}

export function stringifyRedactedEvent(value: unknown): string {
  const redacted = stringifyRedactedPayload(value);
  return redacted.length > 2000 ? `${redacted.slice(0, 2000)}…<truncated>` : redacted;
}
