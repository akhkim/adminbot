import { describe, expect, it, vi } from "vitest";
import type { AdminBotUnitOfWork, AdministratorPolicyRecord, GovernedActionRecord, GovernanceRepository, TransactionBoundary } from "@adminbot/ports";
import { GovernanceService, type GovernanceActor } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-08T12:00:00.000Z");
const actor: GovernanceActor = { accountId: "account-1", organizationId, personId: "person-1", displayName: "Synthetic Member", roles: ["member"], authenticationLevel: "recent_reauthentication" };

describe("GovernanceService", () => {
  it("requires authentication before accepting a reimbursement proposal", async () => {
    const transactions = { read: vi.fn(), write: vi.fn() } as unknown as TransactionBoundary;
    const service = new GovernanceService({ transactions, organizationId, now: () => now });
    const result = await service.proposeReimbursement(undefined, submission());
    expect(result).toMatchObject({ status: 401, body: { code: "not_authenticated" } });
    expect(transactions.write).not.toHaveBeenCalled();
  });

  it("creates an immutable T3 approval-bound proposal with an exact total", async () => {
    const created: GovernedActionRecord[] = [];
    const governance = repository({
      createAction: vi.fn(async (input) => {
        const record = { ...input, approvals: [], updatedAt: input.now } as GovernedActionRecord;
        created.push(record); return record;
      }),
    });
    const service = serviceWith(governance);
    const result = await service.proposeReimbursement(actor, submission());
    expect(result.status).toBe(201);
    expect(created[0]).toMatchObject({ risk: "T3_sensitive", approvalQuorum: 1, requesterMayApprove: false, state: "awaiting_approval" });
    expect(created[0]?.canonicalPayload).toMatchObject({ exactTotal: { currency: "CAD", minorUnits: 4125 }, destination: "finance_office" });
    expect(created[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("enforces separation of duty for the requester", async () => {
    const action = actionRecord({ requestedByPersonId: actor.personId });
    const governance = repository({ findAction: vi.fn(async () => action) });
    const service = serviceWith(governance);
    const result = await service.decide({ ...actor, roles: ["administrator"] }, action.id, binding(action, "approve"));
    expect(result).toMatchObject({ status: 403, body: { code: "not_authorized" } });
    expect(governance.decide).not.toHaveBeenCalled();
  });

  it("records a fail-closed execution when no connector is configured", async () => {
    const action = actionRecord({ state: "approved", requestedByPersonId: "person-2" });
    const governance = repository({ findAction: vi.fn(async () => action), recordFailedExecution: vi.fn(async () => ({ ...action, state: "failed", safeFailureCode: "connector_unavailable" } as GovernedActionRecord)) });
    const service = serviceWith(governance);
    const result = await service.execute({ ...actor, roles: ["administrator"] }, action.id, binding(action));
    expect(result).toMatchObject({ status: 503, body: { code: "connector_unavailable", retryable: true } });
    expect(governance.recordFailedExecution).toHaveBeenCalledWith(expect.objectContaining({ safeFailureCode: "connector_unavailable" }));
  });
});

function serviceWith(governance: GovernanceRepository): GovernanceService {
  const unit = { governance, audit: { append: vi.fn(async () => undefined) }, outbox: { enqueue: vi.fn(async () => undefined) } } as unknown as AdminBotUnitOfWork;
  const transactions: TransactionBoundary = { read: async (work) => work(unit), write: async (work) => work(unit) };
  let sequence = 0;
  return new GovernanceService({ transactions, organizationId, now: () => now, id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });
}

function repository(overrides: Partial<GovernanceRepository> = {}): GovernanceRepository {
  return {
    getOrCreatePolicy: vi.fn(async () => policy()), replacePolicy: vi.fn(), listActions: vi.fn(async () => []),
    findAction: vi.fn(async () => undefined), findActionByRequest: vi.fn(async () => undefined),
    createAction: vi.fn(), decide: vi.fn(), recordFailedExecution: vi.fn(), ...overrides,
  } as GovernanceRepository;
}

function policy(): AdministratorPolicyRecord { return { organizationId, policyVersion: "0.1.0", reimbursementSubmissionEnabled: true, reimbursementApprovalRoles: ["administrator", "approver"], reimbursementApprovalQuorum: 1, reimbursementRequesterMayApprove: false, reimbursementDistinctApprovers: true, reimbursementRecentReauthenticationRequired: true, reimbursementApprovalExpiryHours: 48, reimbursementDestinations: ["finance_office"], version: 1, createdAt: now, updatedAt: now }; }
function submission() { return { clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", packId: "waterloo_travel_v1", destination: "finance_office", attestedAccurate: true, draft: { claimantName: "Synthetic Member", claimantEmail: "member@example.test", claimantAddress: "1 Test Way", claimantTitle: "Researcher", tripTitle: "Workshop", tripDates: "2026-08-01", tripLocation: "Toronto", purpose: "Present synthetic work", currency: "CAD", expenses: [{ date: "2026-08-01", description: "Rail", category: "transport", amount: 41.25, currency: "CAD" }] } }; }
function actionRecord(overrides: Partial<GovernedActionRecord> = {}): GovernedActionRecord { return { id: "action-1", organizationId, clientRequestId: "request-1", revision: 1, actionType: "reimbursements.submit", actionVersion: "0.1.0", state: "awaiting_approval", summary: "Submit reimbursement", canonicalPayload: { destination: "finance_office" }, payloadHash: "a".repeat(64), requestedByAccountId: "account-2", requestedByPersonId: "person-2", requestedByName: "Other Member", requestedAt: now, policyDecisionId: "policy-decision-1", policyVersion: "0.1.0", risk: "T3_sensitive", eligibleRoles: ["administrator", "approver"], approvalQuorum: 1, requesterMayApprove: false, distinctPeople: true, recentReauthenticationRequired: true, expiresAt: new Date("2026-08-10T12:00:00.000Z"), approvals: [], updatedAt: now, ...overrides }; }
function binding(action: GovernedActionRecord, decision?: "approve" | "reject") { return { actionRevision: action.revision, payloadHash: action.payloadHash, policyDecisionId: action.policyDecisionId, ...(decision === undefined ? {} : { decision }) }; }
