import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverleafFetch } from "../connectors/overleaf.js";
import { createAdminBotOverleafExecutor } from "../connectors/overleaf.js";
import type { FundingAudit } from "../workflows/papers/funding-audit.js";
import { auditNow, fundingInput } from "../workflows/papers/funding-audit.test-helpers.js";
import { AdminBotService, payloadHash } from "./service.js";

function setup() {
  const fetchImpl = vi.fn<OverleafFetch>(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "ok",
  }));
  const service = new AdminBotService(undefined, {
    executor: createAdminBotOverleafExecutor({
      fetchImpl,
      env: {
        OVERLEAF_API_BASE_URL: "https://bridge.example.test",
        OVERLEAF_ACCESS_TOKEN: "synthetic",
      },
    }),
  });
  return { fetchImpl, service };
}
function request() {
  const input = fundingInput();
  return {
    type: "paper.overleaf_edit" as const,
    summary: "Synthetic funding review",
    proposed_payload: {
      action: "apply_overleaf_project_edits",
      mode: "funding_check",
      paper: structuredClone(input.paper),
      requestedEdits: "Review candidate credit; preserve coauthor support and author order.",
      targetFiles: ["main.tex"],
      fundingAudit: { input },
    },
  };
}
function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}
describe("funding audit through generic proposal API/CLI boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(auditNow);
  });
  afterEach(() => vi.useRealTimers());
  it("computes rather than trusts caller findings, hashes them, and retains two-admin execution gate", async () => {
    const { service, fetchImpl } = setup();
    const created = unwrap(service.createProposal(request()));
    const payload = created.proposed_payload as { fundingAudit: FundingAudit };
    expect(payload.fundingAudit.findings[0].decision).toBe("include");
    expect(created.payload_hash).toBe(
      payloadHash({
        ...request(),
        risk_tier: "T4",
        proposed_payload: created.proposed_payload,
        target: created.target,
      }),
    );
    expect(created.approval_requirement.min_approvals).toBe(2);
    expect((await service.execute(created.id, { dry_run: false })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    unwrap(
      service.approve(created.id, {
        payload_hash: created.payload_hash,
        approver_role: "admin",
        approver_id: "admin-a",
      }),
    );
    expect((await service.execute(created.id, { dry_run: false })).ok).toBe(false);
    unwrap(
      service.approve(created.id, {
        payload_hash: created.payload_hash,
        approver_role: "admin",
        approver_id: "admin-b",
      }),
    );
    expect((await service.execute(created.id, { dry_run: false })).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}");
    expect(body.fundingAudit.preservedCredits).toEqual(fundingInput().existingCredits);
  });
  it("allows inspection of unknown findings but never calls the bridge even after approvals", async () => {
    const { service, fetchImpl } = setup();
    const req = request();
    req.proposed_payload.fundingAudit.input.facts = [];
    const created = unwrap(service.createProposal(req));
    expect(
      (created.proposed_payload as { fundingAudit: FundingAudit }).fundingAudit.findings[0]
        .decision,
    ).toBe("unknown");
    for (const id of ["a", "b"]) {
      unwrap(
        service.approve(created.id, {
          payload_hash: created.payload_hash,
          approver_role: "admin",
          approver_id: id,
        }),
      );
    }
    expect((await service.execute(created.id, { dry_run: false })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects absent input and paper mismatch at creation before storing a proposal", () => {
    const { service } = setup();
    const req = request();
    req.proposed_payload.paper.title = "Other paper";
    expect(service.createProposal(req)).toMatchObject({ ok: false, status: 400 });
    expect(
      service.createProposal({
        ...req,
        proposed_payload: { ...req.proposed_payload, fundingAudit: undefined },
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});
