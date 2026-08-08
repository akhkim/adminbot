import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import type {
  AccessRoleName,
  AdministratorPolicyRecord,
  GovernedActionRecord,
  GovernanceRepository,
  JsonValue,
} from "@adminbot/ports";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;
type ActionRow = Prisma.GovernedActionGetPayload<{ include: { approvals: true } }>;

export class PrismaGovernanceRepository implements GovernanceRepository {
  constructor(private readonly database: DatabaseClient) {}

  async getOrCreatePolicy(organizationId: string, now: Date): Promise<AdministratorPolicyRecord> {
    const row = await this.database.administratorPolicy.upsert({
      where: { organizationId },
      update: {},
      create: {
        organizationId,
        policyVersion: "0.1.0",
        reimbursementSubmissionEnabled: true,
        reimbursementApprovalRoles: ["administrator", "approver"],
        reimbursementApprovalQuorum: 1,
        reimbursementRequesterMayApprove: false,
        reimbursementDistinctApprovers: true,
        reimbursementRecentReauthenticationRequired: true,
        reimbursementApprovalExpiryHours: 48,
        reimbursementDestinations: ["finance_office"],
        createdAt: now,
        updatedAt: now,
      },
    });
    return toPolicy(row);
  }

  async replacePolicy(input: Parameters<GovernanceRepository["replacePolicy"]>[0]) {
    const changed = await this.database.administratorPolicy.updateMany({
      where: { organizationId: input.organizationId, version: input.expectedVersion },
      data: {
        policyVersion: input.policyVersion,
        reimbursementSubmissionEnabled: input.reimbursementSubmissionEnabled,
        reimbursementApprovalRoles: [...input.reimbursementApprovalRoles],
        reimbursementApprovalQuorum: input.reimbursementApprovalQuorum,
        reimbursementRequesterMayApprove: input.reimbursementRequesterMayApprove,
        reimbursementDistinctApprovers: input.reimbursementDistinctApprovers,
        reimbursementRecentReauthenticationRequired: input.reimbursementRecentReauthenticationRequired,
        reimbursementApprovalExpiryHours: input.reimbursementApprovalExpiryHours,
        reimbursementDestinations: [...input.reimbursementDestinations],
        version: { increment: 1 },
        updatedAt: input.now,
      },
    });
    if (changed.count !== 1) return "conflict" as const;
    return toPolicy(await this.database.administratorPolicy.findUniqueOrThrow({ where: { organizationId: input.organizationId } }));
  }

  async listActions(organizationId: string): Promise<readonly GovernedActionRecord[]> {
    const rows = await this.database.governedAction.findMany({
      where: { organizationId },
      include: { approvals: { orderBy: [{ decidedAt: "asc" }, { id: "asc" }] } },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    });
    return this.hydrate(rows);
  }

  async findAction(organizationId: string, actionId: string) {
    const row = await this.database.governedAction.findFirst({
      where: { organizationId, id: actionId },
      include: { approvals: { orderBy: [{ decidedAt: "asc" }, { id: "asc" }] } },
    });
    return row === null ? undefined : (await this.hydrate([row]))[0];
  }

  async findActionByRequest(organizationId: string, clientRequestId: string) {
    const row = await this.database.governedAction.findUnique({
      where: { organizationId_clientRequestId: { organizationId, clientRequestId } },
      include: { approvals: { orderBy: [{ decidedAt: "asc" }, { id: "asc" }] } },
    });
    return row === null ? undefined : (await this.hydrate([row]))[0];
  }

  async createAction(input: Parameters<GovernanceRepository["createAction"]>[0]) {
    try {
      const row = await this.database.governedAction.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          clientRequestId: input.clientRequestId,
          revision: input.revision,
          actionType: input.actionType,
          actionVersion: input.actionVersion,
          state: input.state,
          summary: input.summary,
          canonicalPayload: input.canonicalPayload as Prisma.InputJsonValue,
          payloadHash: input.payloadHash,
          requestedByAccountId: input.requestedByAccountId,
          requestedByPersonId: input.requestedByPersonId,
          requestedAt: input.requestedAt,
          policyDecisionId: input.policyDecisionId,
          policyVersion: input.policyVersion,
          risk: input.risk,
          eligibleRoles: [...input.eligibleRoles],
          approvalQuorum: input.approvalQuorum,
          requesterMayApprove: input.requesterMayApprove,
          distinctPeople: input.distinctPeople,
          recentReauthenticationRequired: input.recentReauthenticationRequired,
          expiresAt: input.expiresAt,
          ...(input.safeFailureCode === undefined ? {} : { safeFailureCode: input.safeFailureCode }),
          createdAt: input.now,
          updatedAt: input.now,
        },
        include: { approvals: true },
      });
      return (await this.hydrate([row]))[0] as GovernedActionRecord;
    } catch (error) {
      if (isUniqueConstraintError(error)) return "request_conflict" as const;
      throw error;
    }
  }

  async decide(input: Parameters<GovernanceRepository["decide"]>[0]) {
    const current = await this.database.governedAction.findFirst({
      where: { id: input.actionId, organizationId: input.organizationId },
      include: { approvals: true },
    });
    if (current === null) return "not_found" as const;
    if (
      current.revision !== input.expectedRevision ||
      current.payloadHash !== input.payloadHash ||
      current.policyDecisionId !== input.policyDecisionId ||
      current.state !== "awaiting_approval"
    ) return "conflict" as const;
    try {
      await this.database.governedApproval.create({
        data: {
          id: input.approval.id,
          actionId: input.actionId,
          actionRevision: input.approval.actionRevision,
          payloadHash: input.approval.payloadHash,
          policyDecisionId: input.approval.policyDecisionId,
          decision: input.approval.decision,
          decidedByPersonId: input.approval.decidedByPersonId,
          roleBasis: [...input.approval.roleBasis],
          ...(input.approval.note === undefined ? {} : { note: input.approval.note }),
          decidedAt: input.approval.decidedAt,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return "already_decided" as const;
      throw error;
    }
    await this.database.governedAction.update({
      where: { id: input.actionId },
      data: { state: input.nextState, updatedAt: input.now },
    });
    return (await this.findAction(input.organizationId, input.actionId)) as GovernedActionRecord;
  }

  async recordFailedExecution(input: Parameters<GovernanceRepository["recordFailedExecution"]>[0]) {
    const changed = await this.database.governedAction.updateMany({
      where: {
        id: input.actionId,
        organizationId: input.organizationId,
        revision: input.expectedRevision,
        payloadHash: input.payloadHash,
        policyDecisionId: input.policyDecisionId,
        state: "approved",
      },
      data: {
        state: "failed",
        safeFailureCode: input.safeFailureCode,
        updatedAt: input.now,
      },
    });
    if (changed.count !== 1) {
      const exists = await this.database.governedAction.count({ where: { id: input.actionId, organizationId: input.organizationId } });
      return exists === 0 ? "not_found" as const : "conflict" as const;
    }
    return (await this.findAction(input.organizationId, input.actionId)) as GovernedActionRecord;
  }

  private async hydrate(rows: readonly ActionRow[]): Promise<readonly GovernedActionRecord[]> {
    const personIds = [...new Set(rows.flatMap((row) => [row.requestedByPersonId, ...row.approvals.map((approval) => approval.decidedByPersonId)]))];
    const people = personIds.length === 0 ? [] : await this.database.person.findMany({ where: { id: { in: personIds } }, select: { id: true, displayName: true } });
    const names = new Map(people.map((person) => [person.id, person.displayName]));
    return rows.map((row) => toAction(row, names));
  }
}

function toPolicy(row: {
  organizationId: string; policyVersion: string; reimbursementSubmissionEnabled: boolean;
  reimbursementApprovalRoles: unknown; reimbursementApprovalQuorum: number;
  reimbursementRequesterMayApprove: boolean; reimbursementDistinctApprovers: boolean;
  reimbursementRecentReauthenticationRequired: boolean; reimbursementApprovalExpiryHours: number;
  reimbursementDestinations: unknown; version: number; createdAt: Date; updatedAt: Date;
}): AdministratorPolicyRecord {
  return { ...row, reimbursementApprovalRoles: roles(row.reimbursementApprovalRoles), reimbursementDestinations: strings(row.reimbursementDestinations) };
}

function toAction(row: ActionRow, names: ReadonlyMap<string, string>): GovernedActionRecord {
  if (row.risk !== "T3_sensitive" && row.risk !== "T4_high_consequence") throw new Error("stored action risk is invalid");
  return {
    id: row.id, organizationId: row.organizationId, clientRequestId: row.clientRequestId,
    revision: row.revision, actionType: row.actionType, actionVersion: row.actionVersion,
    state: row.state, summary: row.summary, canonicalPayload: json(row.canonicalPayload), payloadHash: row.payloadHash,
    requestedByAccountId: row.requestedByAccountId, requestedByPersonId: row.requestedByPersonId,
    requestedByName: names.get(row.requestedByPersonId) ?? "Unknown person", requestedAt: row.requestedAt,
    policyDecisionId: row.policyDecisionId, policyVersion: row.policyVersion, risk: row.risk,
    eligibleRoles: roles(row.eligibleRoles), approvalQuorum: row.approvalQuorum,
    requesterMayApprove: row.requesterMayApprove, distinctPeople: row.distinctPeople,
    recentReauthenticationRequired: row.recentReauthenticationRequired, expiresAt: row.expiresAt,
    approvals: row.approvals.map((approval) => ({
      id: approval.id, actionId: approval.actionId, actionRevision: approval.actionRevision,
      payloadHash: approval.payloadHash, policyDecisionId: approval.policyDecisionId,
      decision: approval.decision, decidedByPersonId: approval.decidedByPersonId,
      decidedByName: names.get(approval.decidedByPersonId) ?? "Unknown person",
      roleBasis: roles(approval.roleBasis), ...(approval.note === null ? {} : { note: approval.note }), decidedAt: approval.decidedAt,
    })),
    ...(row.safeFailureCode === null ? {} : { safeFailureCode: row.safeFailureCode }), updatedAt: row.updatedAt,
  };
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("stored string array is invalid");
  return value as string[];
}
function roles(value: unknown): readonly AccessRoleName[] { return strings(value) as readonly AccessRoleName[]; }
function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]));
  throw new Error("stored action payload is invalid");
}
function isUniqueConstraintError(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"; }
