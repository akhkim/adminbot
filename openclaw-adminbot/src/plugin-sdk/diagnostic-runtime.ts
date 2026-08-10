// Diagnostic flag/event helpers for plugins that want narrow runtime gating.

export { isDiagnosticFlagEnabled } from "../infra/diagnostics/diagnostic-flags.js";
export type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
  DiagnosticModelCallContent,
} from "../infra/diagnostics/diagnostic-events.js";
export type { DiagnosticModelContentCapturePolicy } from "../infra/diagnostics/diagnostic-llm-content.js";
export {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  hasPendingInternalDiagnosticEvent,
  isInternalDiagnosticEventMetadata,
  isDiagnosticsEnabled,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostics/diagnostic-events.js";
export { resolveDiagnosticModelContentCapturePolicy } from "../infra/diagnostics/diagnostic-llm-content.js";
export type { DiagnosticTraceContext } from "../infra/diagnostics/diagnostic-trace-context.js";
export {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  parseDiagnosticTraceparent,
} from "../infra/diagnostics/diagnostic-trace-context.js";
