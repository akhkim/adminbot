import "../common/primitives.tsp";
import "../common/errors.tsp";
import "./privacy.tsp";

using AdminBot.Contracts.Common;
using AdminBot.Contracts.Privacy;

namespace AdminBot.Contracts.Capabilities;

enum CapabilityKind {
  command,
  query,
  reasoning,
}

enum Audience {
  public,
  member,
  approver,
  administrator,
  service,
}

model CapabilityDefinition {
  name: CapabilityName;
  version: SemVer;
  summary: string;
  inputSchema: SchemaRef;
  outputSchema: SchemaRef;
  permission: Permission;
  audiences: Audience[];
  maximumInputClass: DataClass;
  metadata?: Record<unknown>;
}

model CommandDefinition extends CapabilityDefinition {
  kind: "command";
  command: CommandName;
  changesState: true;
}

model QueryDefinition extends CapabilityDefinition {
  kind: "query";
  query: QueryName;
  changesState: false;
}

model ReasoningDefinition extends CapabilityDefinition {
  kind: "reasoning";
  changesState: false;
  allowedPurposes: string[];
}

union RegisteredCapability {
  command: CommandDefinition,
  query: QueryDefinition,
  reasoning: ReasoningDefinition,
}

interface CapabilityCatalog {
  get(name: CapabilityName): RegisteredCapability | ErrorResponse;
  list(audience?: Audience): RegisteredCapability[];
}
