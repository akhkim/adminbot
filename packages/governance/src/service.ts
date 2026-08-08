import { createHash, randomUUID } from "node:crypto";
import type { ErrorResponse } from "@adminbot/api-contracts";
import type {
  AccessRoleName,
  AdministratorPolicyRecord,
  GovernedActionRecord,
  GovernanceRepository,
  JsonValue,
  TransactionBoundary,
} from "@adminbot/ports";
import {
  missingDraftFields,
  ReimbursementValidationError,
  validateDraft,
} from "@adminbot/reimbursements/validation";

export interface GovernanceActor {
  readonly accountId: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly roles: readonly AccessRoleName[];
  readonly authenticationLevel: "single_factor" | "recent_reauthentication";
}

export type GovernanceResult =
  | Readonly<{ status: 200 | 201; body: unknown; ok: true }>
  | Readonly<{ status: 400 | 401 | 403 | 404 | 409 | 412 | 503; body: ErrorResponse; ok: false }>;

export interface GovernanceServiceOptions {
  readonly transactions: TransactionBoundary;
  readonly organizationId: string;
  readonly now?: () => Date;
  readonly id?: () => string;
}

const ACTION_TYPE = "reimbursements.submit";
const ACTION_VERSION = "0.1.0";

export class GovernanceService {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: GovernanceServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async getPolicy(actor: GovernanceActor | undefined): Promise<GovernanceResult> {
    const denied = authorize(actor, this.options.organizationId, ["administrator"]);
    if (denied !== undefined) return denied;
    const body = await this.options.transactions.write(async (unit) => toPolicy(await repository(unit.governance).getOrCreatePolicy(this.options.organizationId, this.now())));
    return ok(body);
  }

  async replacePolicy(actor: GovernanceActor | undefined, raw: unknown): Promise<GovernanceResult> {
    const denied = authorize(actor, this.options.organizationId, ["administrator"], true);
    if (denied !== undefined) return denied;
    let input: PolicyInput;
    try { input = policyInput(raw); } catch (error) { return invalid(error); }
    const now = this.now();
    return this.options.transactions.write(async (unit) => {
      const governance = repository(unit.governance);
      const current = await governance.getOrCreatePolicy(this.options.organizationId, now);
      const policyVersion = incrementPatch(current.policyVersion);
      const saved = await governance.replacePolicy({ organizationId: this.options.organizationId, expectedVersion: input.expectedVersion, policyVersion, ...input.settings, now });
      if (saved === "conflict") return failure(409, "conflict", "policy settings changed; reload before saving");
      await unit.audit.append({ id: this.id(), organizationId: this.options.organizationId, eventType: "policy.settings_replaced", actorId: actor!.personId, safeDetails: { policyVersion, reason: input.reason }, occurredAt: now });
      await unit.outbox.enqueue({ id: this.id(), organizationId: this.options.organizationId, eventType: "policy.settings_replaced", aggregateType: "administrator_policy", aggregateId: this.options.organizationId, payload: { policyVersion, version: saved.version }, availableAt: now });
      return ok(toPolicy(saved));
    });
  }

  async proposeReimbursement(actor: GovernanceActor | undefined, raw: unknown): Promise<GovernanceResult> {
    const denied = authorize(actor, this.options.organizationId, ["external_collaborator", "member", "administrator", "approver"]);
    if (denied !== undefined) return denied;
    let input: SubmissionInput;
    try { input = submissionInput(raw); } catch (error) { return invalid(error); }
    const now = this.now();
    return this.options.transactions.write(async (unit) => {
      const governance = repository(unit.governance);
      const policy = await governance.getOrCreatePolicy(this.options.organizationId, now);
      if (!policy.reimbursementSubmissionEnabled) return failure(403, "policy_denied", "reimbursement submission proposals are disabled");
      if (!policy.reimbursementDestinations.includes(input.destination)) return failure(403, "policy_denied", "the selected reimbursement destination is not permitted");
      const canonicalPayload: JsonValue = {
        reimbursementId: input.clientRequestId, claimantId: actor!.personId, packId: input.packId,
        packetInputDigest: digest({ packId: input.packId, draft: input.draft }),
        destination: input.destination, exactTotal: input.exactTotal, draft: input.draft as JsonValue,
      };
      const payloadHash = digest(canonicalPayload);
      const existing = await governance.findActionByRequest(this.options.organizationId, input.clientRequestId);
      if (existing !== undefined) {
        return existing.payloadHash === payloadHash ? ok(toAction(existing)) : failure(409, "conflict", "clientRequestId is already bound to a different reimbursement payload");
      }
      const expiresAt = new Date(now.getTime() + policy.reimbursementApprovalExpiryHours * 3_600_000);
      const record = await governance.createAction({
        id: this.id(), organizationId: this.options.organizationId, clientRequestId: input.clientRequestId,
        revision: 1, actionType: ACTION_TYPE, actionVersion: ACTION_VERSION, state: "awaiting_approval",
        summary: `Submit ${input.exactTotal.currency} ${(input.exactTotal.minorUnits / 100).toFixed(2)} reimbursement to ${input.destination}`,
        canonicalPayload, payloadHash, requestedByAccountId: actor!.accountId, requestedByPersonId: actor!.personId,
        requestedByName: actor!.displayName, requestedAt: now, policyDecisionId: this.id(), policyVersion: policy.policyVersion,
        risk: "T3_sensitive", eligibleRoles: policy.reimbursementApprovalRoles,
        approvalQuorum: policy.reimbursementApprovalQuorum, requesterMayApprove: policy.reimbursementRequesterMayApprove,
        distinctPeople: policy.reimbursementDistinctApprovers,
        recentReauthenticationRequired: policy.reimbursementRecentReauthenticationRequired,
        expiresAt, now,
      });
      if (record === "request_conflict") return failure(409, "conflict", "submission request is already being processed");
      await unit.audit.append({ id: this.id(), organizationId: this.options.organizationId, eventType: "action.proposed", actorId: actor!.personId, subjectId: record.id, safeDetails: { actionType: ACTION_TYPE, payloadHash, risk: "T3_sensitive" }, occurredAt: now });
      await unit.outbox.enqueue({ id: this.id(), organizationId: this.options.organizationId, eventType: "action.proposed", aggregateType: "action", aggregateId: record.id, payload: { actionId: record.id, actionType: ACTION_TYPE, payloadHash }, availableAt: now });
      return created(toAction(record));
    });
  }

  async listActions(actor: GovernanceActor | undefined): Promise<GovernanceResult> {
    const denied = authorize(actor, this.options.organizationId, ["administrator", "approver"]);
    if (denied !== undefined) return denied;
    const now = this.now();
    const actions = await this.options.transactions.read(async (unit) => repository(unit.governance).listActions(this.options.organizationId));
    return ok({ viewerPersonId: actor!.personId, viewerRoles: actor!.roles, actions: actions.map(toAction), reimbursementConnectorAvailable: false, asOf: now.toISOString() });
  }

  async decide(actor: GovernanceActor | undefined, actionId: string, raw: unknown): Promise<GovernanceResult> {
    const denied = authorize(actor, this.options.organizationId, ["administrator", "approver"]);
    if (denied !== undefined) return denied;
    let input: DecisionInput;
    try { input = decisionInput(raw); } catch (error) { return invalid(error); }
    const now = this.now();
    return this.options.transactions.write(async (unit) => {
      const governance = repository(unit.governance);
      const action = await governance.findAction(this.options.organizationId, actionId);
      if (action === undefined) return failure(404, "not_found", "action not found");
      if (action.expiresAt <= now) return failure(409, "state_invalid", "the approval window has expired");
      if (action.payloadHash !== input.payloadHash || action.policyDecisionId !== input.policyDecisionId || action.revision !== input.actionRevision) return failure(409, "approval_hash_mismatch", "the action binding changed; reload before deciding");
      const roleBasis = actor!.roles.filter((role) => action.eligibleRoles.includes(role));
      if (roleBasis.length === 0) return failure(403, "not_authorized", "your current roles are not eligible to approve this action");
      if (!action.requesterMayApprove && action.requestedByPersonId === actor!.personId) return failure(403, "not_authorized", "requesters cannot approve their own reimbursement submission");
      if (action.recentReauthenticationRequired && actor!.authenticationLevel !== "recent_reauthentication") return failure(403, "not_authorized", "recent reauthentication is required to decide this action");
      const approvalsAfter = action.approvals.filter((approval) => approval.decision === "approve").length + (input.decision === "approve" ? 1 : 0);
      const nextState = input.decision === "reject" ? "rejected" : approvalsAfter >= action.approvalQuorum ? "approved" : "awaiting_approval";
      const result = await governance.decide({ organizationId: this.options.organizationId, actionId, expectedRevision: input.actionRevision, payloadHash: input.payloadHash, policyDecisionId: input.policyDecisionId, approval: { id: this.id(), actionId, actionRevision: input.actionRevision, payloadHash: input.payloadHash, policyDecisionId: input.policyDecisionId, decision: input.decision, decidedByPersonId: actor!.personId, roleBasis, ...(input.note === undefined ? {} : { note: input.note }), decidedAt: now }, nextState, now });
      if (result === "not_found") return failure(404, "not_found", "action not found");
      if (result === "already_decided") return failure(409, "conflict", "you already decided this action");
      if (result === "conflict") return failure(409, "approval_hash_mismatch", "the action changed; reload before deciding");
      await unit.audit.append({ id: this.id(), organizationId: this.options.organizationId, eventType: `action.${input.decision}d`, actorId: actor!.personId, subjectId: actionId, safeDetails: { payloadHash: input.payloadHash, actionRevision: input.actionRevision }, occurredAt: now });
      return ok(toAction(result));
    });
  }

  async execute(actor: GovernanceActor | undefined, actionId: string, raw: unknown): Promise<GovernanceResult> {
    const denied = authorize(actor, this.options.organizationId, ["administrator", "approver"], true);
    if (denied !== undefined) return denied;
    let input: ExecutionInput;
    try { input = executionInput(raw); } catch (error) { return invalid(error); }
    const now = this.now();
    return this.options.transactions.write(async (unit) => {
      const governance = repository(unit.governance);
      const action = await governance.findAction(this.options.organizationId, actionId);
      if (action === undefined) return failure(404, "not_found", "action not found");
      if (action.revision !== input.actionRevision || action.payloadHash !== input.payloadHash || action.policyDecisionId !== input.policyDecisionId) return failure(409, "approval_hash_mismatch", "the approved action binding changed; reload before execution");
      if (action.state !== "approved") return failure(409, "approval_quorum_missing", "the action does not have an active approval quorum");
      const policy = await governance.getOrCreatePolicy(this.options.organizationId, now);
      const payload = record(action.canonicalPayload, "canonical payload");
      if (policy.policyVersion !== action.policyVersion || !policy.reimbursementSubmissionEnabled || !policy.reimbursementDestinations.includes(String(payload.destination ?? ""))) return failure(412, "policy_changed", "policy changed after approval; create a new proposal");
      const failed = await governance.recordFailedExecution({ organizationId: this.options.organizationId, actionId, expectedRevision: input.actionRevision, payloadHash: input.payloadHash, policyDecisionId: input.policyDecisionId, safeFailureCode: "connector_unavailable", now });
      if (typeof failed === "string") return failure(failed === "not_found" ? 404 : 409, failed === "not_found" ? "not_found" : "conflict", failed === "not_found" ? "action not found" : "action changed before execution");
      await unit.audit.append({ id: this.id(), organizationId: this.options.organizationId, eventType: "action.execution_failed", actorId: actor!.personId, subjectId: actionId, safeDetails: { safeFailureCode: "connector_unavailable", payloadHash: input.payloadHash }, occurredAt: now });
      return failure(503, "connector_unavailable", "no verified reimbursement connector is configured; no claim was submitted");
    });
  }
}

interface PolicyInput { readonly expectedVersion: number; readonly reason: string; readonly settings: Omit<AdministratorPolicyRecord, "organizationId" | "policyVersion" | "version" | "createdAt" | "updatedAt"> }
interface SubmissionInput { readonly clientRequestId: string; readonly packId: "waterloo_travel_v1"; readonly draft: ReturnType<typeof validateDraft>; readonly destination: string; readonly exactTotal: { readonly currency: string; readonly minorUnits: number } }
interface DecisionInput { readonly actionRevision: number; readonly payloadHash: string; readonly policyDecisionId: string; readonly decision: "approve" | "reject"; readonly note?: string }
interface ExecutionInput { readonly actionRevision: number; readonly payloadHash: string; readonly policyDecisionId: string }

function policyInput(value: unknown): PolicyInput {
  const input = record(value, "policy settings");
  const expectedVersion = integer(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
  const reason = text(input.reason, "reason", 1, 2_000);
  const rawRoles = stringArray(input.reimbursementApprovalRoles, "reimbursementApprovalRoles");
  if (rawRoles.some((role) => !isRole(role))) throw new Error("reimbursementApprovalRoles may contain only administrator and approver");
  const reimbursementApprovalRoles = [...new Set(rawRoles)] as AccessRoleName[];
  if (reimbursementApprovalRoles.length === 0) throw new Error("at least one administrator or approver role is required");
  const reimbursementDestinations = [...new Set(stringArray(input.reimbursementDestinations, "reimbursementDestinations").map((item) => item.trim()))];
  if (reimbursementDestinations.some((item) => !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,239}$/u.test(item))) throw new Error("reimbursementDestinations contains an invalid destination identifier");
  return { expectedVersion, reason, settings: {
    reimbursementSubmissionEnabled: boolean(input.reimbursementSubmissionEnabled, "reimbursementSubmissionEnabled"),
    reimbursementApprovalRoles, reimbursementApprovalQuorum: integer(input.reimbursementApprovalQuorum, "reimbursementApprovalQuorum", 1, 5),
    reimbursementRequesterMayApprove: boolean(input.reimbursementRequesterMayApprove, "reimbursementRequesterMayApprove"),
    reimbursementDistinctApprovers: boolean(input.reimbursementDistinctApprovers, "reimbursementDistinctApprovers"),
    reimbursementRecentReauthenticationRequired: boolean(input.reimbursementRecentReauthenticationRequired, "reimbursementRecentReauthenticationRequired"),
    reimbursementApprovalExpiryHours: integer(input.reimbursementApprovalExpiryHours, "reimbursementApprovalExpiryHours", 1, 168),
    reimbursementDestinations,
  } };
}

function submissionInput(value: unknown): SubmissionInput {
  const input = record(value, "submission proposal");
  const clientRequestId = text(input.clientRequestId, "clientRequestId", 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(clientRequestId)) throw new Error("clientRequestId must be a UUID v4");
  if (input.packId !== "waterloo_travel_v1") throw new Error("packId is not supported");
  if (input.attestedAccurate !== true) throw new Error("attestedAccurate must be true");
  const destination = text(input.destination, "destination", 1, 240);
  const draft = validateDraft(input.draft);
  const missing = missingDraftFields(draft);
  if (missing.length > 0) throw new Error(`the reviewed draft is incomplete: ${missing.join(", ")}`);
  const currencies = new Set(draft.expenses.map((expense) => expense.currency?.trim().toUpperCase()));
  if (currencies.size !== 1 || currencies.has(undefined)) throw new Error("all submitted expenses must use one explicit currency");
  const currency = [...currencies][0] as string;
  if (!/^[A-Z]{3}$/u.test(currency)) throw new Error("expense currency must be a three-letter code");
  const declaredCurrency = (draft.currency === "OTHER" ? draft.otherCurrency : draft.currency)?.trim().toUpperCase();
  if (declaredCurrency !== currency) throw new Error("the declared reimbursement currency must match every expense row");
  const minorUnits = draft.expenses.reduce((total, expense) => total + Math.round((expense.amount as number) * 100), 0);
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) throw new Error("the reimbursement total must be positive and representable in minor units");
  return { clientRequestId, packId: input.packId, draft, destination, exactTotal: { currency, minorUnits } };
}

function decisionInput(value: unknown): DecisionInput {
  const input = executionInput(value);
  const raw = record(value, "decision");
  if (raw.decision !== "approve" && raw.decision !== "reject") throw new Error("decision must be approve or reject");
  const note = raw.note === undefined ? undefined : text(raw.note, "note", 0, 2_000);
  return { ...input, decision: raw.decision, ...(note === undefined ? {} : { note }) };
}
function executionInput(value: unknown): ExecutionInput { const input = record(value, "action binding"); return { actionRevision: integer(input.actionRevision, "actionRevision", 1, Number.MAX_SAFE_INTEGER), payloadHash: hash(input.payloadHash, "payloadHash"), policyDecisionId: text(input.policyDecisionId, "policyDecisionId", 1, 100) }; }

function authorize(actor: GovernanceActor | undefined, organizationId: string, roles: readonly AccessRoleName[], recent = false): GovernanceResult | undefined {
  if (actor === undefined) return failure(401, "not_authenticated", "authentication is required");
  if (actor.organizationId !== organizationId || !actor.roles.some((role) => roles.includes(role))) return failure(403, "not_authorized", "your current role cannot perform this operation");
  if (recent && actor.authenticationLevel !== "recent_reauthentication") return failure(403, "not_authorized", "recent reauthentication is required");
  return undefined;
}
function repository(value: GovernanceRepository | undefined): GovernanceRepository { if (value === undefined) throw new Error("governance repository is unavailable"); return value; }
function toPolicy(value: AdministratorPolicyRecord) { return { ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() }; }
function toAction(value: GovernedActionRecord) { return { ...value, requestedAt: value.requestedAt.toISOString(), expiresAt: value.expiresAt.toISOString(), updatedAt: value.updatedAt.toISOString(), approvals: value.approvals.map((approval) => ({ id: approval.id, decision: approval.decision, decidedBy: approval.decidedByPersonId, decidedByName: approval.decidedByName, roleBasis: approval.roleBasis, ...(approval.note === undefined ? {} : { note: approval.note }), decidedAt: approval.decidedAt.toISOString() })) }; }
function digest(value: JsonValue): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object).sort().map((key) => {
    const item = object[key];
    if (item === undefined) throw new Error("canonical JSON contains an undefined value");
    return `${JSON.stringify(key)}:${canonical(item)}`;
  }).join(",")}}`;
}
function incrementPatch(version: string): string { const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version); return match === null ? "0.1.0" : `${match[1]}.${match[2]}.${Number(match[3]) + 1}`; }
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function text(value: unknown, label: string, min: number, max: number): string { if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw new Error(`${label} must contain ${min}-${max} characters`); return value.trim(); }
function integer(value: unknown, label: string, min: number, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer from ${min} to ${max}`); return value as number; }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`); return value; }
function stringArray(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`); return value as string[]; }
function hash(value: unknown, label: string): string { const result = text(value, label, 64, 64); if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${label} must be a SHA-256 digest`); return result; }
function isRole(value: string): value is AccessRoleName { return value === "administrator" || value === "approver"; }
function invalid(error: unknown): GovernanceResult { const message = error instanceof ReimbursementValidationError || error instanceof Error ? error.message : "request is invalid"; return failure(400, "payload_invalid", message); }
function ok(body: unknown): GovernanceResult { return { status: 200, body, ok: true }; }
function created(body: unknown): GovernanceResult { return { status: 201, body, ok: true }; }
function failure(status: 400 | 401 | 403 | 404 | 409 | 412 | 503, code: ErrorResponse["code"], message: string): GovernanceResult { return { status, body: { code, message, retryable: status === 503 }, ok: false }; }
