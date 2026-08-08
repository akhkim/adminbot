import "../common/primitives.tsp";
import "../common/errors.tsp";

using AdminBot.Contracts.Common;

namespace AdminBot.Contracts.Automation;

model CommandRequest {
  requestId: RequestId;
  command: CommandName;
  payload: unknown;
  idempotencyKey: IdempotencyKey;
}

model QueryRequest {
  requestId: RequestId;
  query: QueryName;
  parameters: unknown;
}

model CommandReceipt {
  output: unknown;
  replayed: boolean;
}

interface CommandBus {
  dispatch(actor: ActorContext, request: CommandRequest):
    | CommandReceipt
    | ErrorResponse;
}

interface QueryBus {
  dispatch(actor: ActorContext, request: QueryRequest): unknown | ErrorResponse;
}

model JobDefinition {
  id: JobDefinitionId;
  version: SemVer;
  name: string;
  schedule?: string;
  timeZone?: string;
  command: CommandName;
  defaultPayload: unknown;
  enabledByDefault: false;
  overlapPolicy: "skip" | "queue_one";
}

model JobCheckpoint {
  cursor?: string;
  state: Record<unknown>;
  savedAt: utcDateTime;
}

model JobRun {
  id: JobRunId;
  definitionId: JobDefinitionId;
  definitionVersion: SemVer;
  trigger: "schedule" | "manual" | "recovery";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  scheduledFor: utcDateTime;
  startedAt?: utcDateTime;
  completedAt?: utcDateTime;
  checkpoint?: JobCheckpoint;
}

/** Job implementations dispatch commands; they never receive a connector registry. */
interface JobRunnerPort {
  run(actor: ActorContext, run: JobRun): void | ErrorResponse;
  saveCheckpoint(runId: JobRunId, checkpoint: JobCheckpoint):
    | void
    | ErrorResponse;
}

model DomainEvent {
  type: string;
  version: int32;
  occurredAt: utcDateTime;
  correlationId: CorrelationId;
  payload: unknown;
}

model OutboxMessage {
  topic: string;
  key: string;
  payload: unknown;
  availableAt: utcDateTime;
}
