import { isRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Responses stream: response.failed diagnostics.
 *
 * A response.failed event with no error details is the hardest transport failure
 * to diagnose, so the event is summarized into a loggable observation. Every
 * identifier-shaped field is hashed rather than logged: the payload can carry
 * prompt-derived text, and this path runs at warn level where redaction is not
 * otherwise applied.
 */
import type { Api, Model } from "../../llm/types.js";
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { RESPONSE_FAILED_NO_DETAILS_MESSAGE, log } from "./openai-transport-stream.constants.js";
import {
  safeDebugValue,
  stringifyRedactedEvent,
  stringifyUnknown,
} from "./openai-transport-stream.payload-debug.js";

export type ResponsesFailedNoDetailsObservation = {
  event: "openai_responses_response_failed_without_details";
  provider: string;
  api: Api;
  transportModel: string;
  providerRuntimeFailureKind: "no_error_details";
  responseId: string;
  responseStatus: string;
  responseModel: string;
  responseObject: string;
  metadataKeys: string[];
  requestIdHashes: string[];
  failureFieldsPreview: string;
  responsePreview: string;
};

export type ResponsesFailedEventSummary = {
  message: string;
  responseId?: string;
  observation?: ResponsesFailedNoDetailsObservation;
};

export const RESPONSE_FAILED_FAILURE_FIELD_KEYS = [
  "error",
  "incomplete_details",
  "status_details",
  "failure_reason",
  "last_error",
  "provider_error",
  "error_details",
] as const;

export function readResponseFailedString(
  record: Record<string, unknown> | undefined,
  key: string,
): string {
  return stringifyUnknown(record?.[key]);
}

export function buildResponsesFailedEventSummary(
  message: string,
  responseId: string | undefined,
  observation?: ResponsesFailedNoDetailsObservation,
): ResponsesFailedEventSummary {
  const summary: ResponsesFailedEventSummary = { message };
  if (responseId) {
    summary.responseId = responseId;
  }
  if (observation) {
    summary.observation = observation;
  }
  return summary;
}

export function isResponseFailedIdentifierKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return (
    normalized === "requestid" ||
    normalized === "xrequestid" ||
    normalized === "providerrequestid" ||
    normalized === "providerresponseid" ||
    normalized === "litellmrequestid" ||
    (normalized.includes("request") && normalized.endsWith("id")) ||
    (normalized.includes("provider") && normalized.endsWith("id"))
  );
}

export function collectResponseFailedIdentifierHashes(
  value: unknown,
  opts: {
    path?: string;
    depth?: number;
    identifierKey?: string;
    out?: string[];
    seen?: WeakSet<object>;
  } = {},
): string[] {
  const path = opts.path ?? "";
  const depth = opts.depth ?? 0;
  const identifierKey = opts.identifierKey ?? "";
  const out = opts.out ?? [];
  const seen = opts.seen ?? new WeakSet<object>();
  if (out.length >= 12 || depth > 4 || !value || typeof value !== "object") {
    return out;
  }
  if (seen.has(value)) {
    return out;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (index >= 8 || out.length >= 12) {
        break;
      }
      const itemString =
        typeof item === "string" || typeof item === "number" ? String(item).trim() : "";
      if (identifierKey && isResponseFailedIdentifierKey(identifierKey) && itemString) {
        out.push(`${path}[${index}]=${redactIdentifier(itemString, { len: 12 })}`);
        continue;
      }
      collectResponseFailedIdentifierHashes(item, {
        path: `${path}[${index}]`,
        depth: depth + 1,
        identifierKey,
        out,
        seen,
      });
    }
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (out.length >= 12) {
      break;
    }
    const childPath = path ? `${path}.${key}` : key;
    const childString =
      typeof child === "string" || typeof child === "number" ? String(child).trim() : "";
    if (isResponseFailedIdentifierKey(key) && childString) {
      out.push(`${childPath}=${redactIdentifier(childString, { len: 12 })}`);
      continue;
    }
    collectResponseFailedIdentifierHashes(child, {
      path: childPath,
      depth: depth + 1,
      identifierKey: isResponseFailedIdentifierKey(key) ? key : undefined,
      out,
      seen,
    });
  }
  return out;
}

export function redactResponseFailedDiagnosticValue(
  value: unknown,
  opts: {
    key?: string;
    depth?: number;
    seen?: WeakSet<object>;
  } = {},
): unknown {
  const key = opts.key ?? "";
  const depth = opts.depth ?? 0;
  if (typeof value === "string" || typeof value === "number") {
    return key && isResponseFailedIdentifierKey(key)
      ? redactIdentifier(String(value), { len: 12 })
      : value;
  }
  if (depth > 6 || !value || typeof value !== "object") {
    return value;
  }
  const seen = opts.seen ?? new WeakSet<object>();
  if (seen.has(value)) {
    return "<circular>";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) =>
      redactResponseFailedDiagnosticValue(item, {
        key,
        depth: depth + 1,
        seen,
      }),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactResponseFailedDiagnosticValue(child, {
      key: childKey,
      depth: depth + 1,
      seen,
    });
  }
  return out;
}

export function buildResponsesFailedFailureFields(
  response: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!response) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  for (const key of RESPONSE_FAILED_FAILURE_FIELD_KEYS) {
    if (response[key] !== undefined && response[key] !== null) {
      fields[key] = response[key];
    }
  }
  return fields;
}

export function buildResponsesFailedNoDetailsObservation(
  event: Record<string, unknown>,
  model: Model,
  response: Record<string, unknown> | undefined = isRecord(event.response)
    ? event.response
    : undefined,
): ResponsesFailedNoDetailsObservation {
  const failureFields = redactResponseFailedDiagnosticValue(
    buildResponsesFailedFailureFields(response),
  ) as Record<string, unknown>;
  const metadataKeys = isRecord(response?.metadata)
    ? Object.keys(response.metadata).toSorted()
    : [];
  const responsePreview = {
    id: readResponseFailedString(response, "id"),
    status: readResponseFailedString(response, "status"),
    model: readResponseFailedString(response, "model"),
    object: readResponseFailedString(response, "object"),
    failureFields,
    metadataKeys,
  };
  return {
    event: "openai_responses_response_failed_without_details",
    provider: model.provider,
    api: model.api,
    transportModel: model.id,
    providerRuntimeFailureKind: "no_error_details",
    responseId: responsePreview.id,
    responseStatus: responsePreview.status,
    responseModel: responsePreview.model,
    responseObject: responsePreview.object,
    metadataKeys,
    requestIdHashes: collectResponseFailedIdentifierHashes(event),
    failureFieldsPreview: stringifyRedactedEvent(failureFields),
    responsePreview: stringifyRedactedEvent(responsePreview),
  };
}

export function summarizeResponsesFailedNoDetailsObservation(
  observation: ResponsesFailedNoDetailsObservation,
): string {
  const requestIds = observation.requestIdHashes.join(",");
  const metadataKeys = observation.metadataKeys.join(",");
  return (
    `responseId=${safeDebugValue(observation.responseId || undefined)} ` +
    `responseStatus=${safeDebugValue(observation.responseStatus || undefined)} ` +
    `responseModel=${safeDebugValue(observation.responseModel || undefined)} ` +
    `requestIds=${requestIds || "none"} metadataKeys=${metadataKeys || "none"} ` +
    `failureFields=${observation.failureFieldsPreview}`
  );
}

export function normalizeResponsesFailedEvent(
  event: Record<string, unknown>,
  model: Model,
): ResponsesFailedEventSummary {
  const response = isRecord(event.response) ? event.response : undefined;
  const responseId = readResponseFailedString(response, "id") || undefined;
  const error = isRecord(response?.error) ? response.error : undefined;
  if (error) {
    const code = readResponseFailedString(error, "code").trim();
    const message = readResponseFailedString(error, "message").trim();
    if (code || message) {
      return buildResponsesFailedEventSummary(
        `${code || "unknown"}: ${message || "no message"}`,
        responseId,
      );
    }
  }
  const incompleteDetails = isRecord(response?.incomplete_details)
    ? response.incomplete_details
    : undefined;
  const incompleteReason = readResponseFailedString(incompleteDetails, "reason");
  if (incompleteReason) {
    return buildResponsesFailedEventSummary(`incomplete: ${incompleteReason}`, responseId);
  }
  return buildResponsesFailedEventSummary(
    RESPONSE_FAILED_NO_DETAILS_MESSAGE,
    responseId,
    buildResponsesFailedNoDetailsObservation(event, model, response),
  );
}

export function logResponsesFailedNoDetails(
  observation: ResponsesFailedNoDetailsObservation,
): void {
  log.warn(
    `[responses] response.failed missing error details provider=${observation.provider} ` +
      `api=${observation.api} model=${observation.transportModel} ` +
      summarizeResponsesFailedNoDetailsObservation(observation),
    observation,
  );
}
