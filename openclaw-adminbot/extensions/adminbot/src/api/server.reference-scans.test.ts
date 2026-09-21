import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const token = "synthetic-service-token";
const instances: ReturnType<typeof createAdminBotMockService>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    if (instance.server.listening) {
      await new Promise<void>((resolve) => {
        instance.server.close(() => resolve());
      });
    }
    instance.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function setup(databasePath?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-reference-scans-"));
  dirs.push(dir);
  const readPdf = vi.fn(async (submissionId: string) => ({
    submission_id: submissionId,
    title: "Synthetic paper",
    bytes: Buffer.from("%PDF-synthetic-v1"),
  }));
  const scanPdf = vi.fn(async () => ({
    provider_scan_id: "synthetic-result",
    response_version: 1,
    citation_count: 1,
    uncertain_count: 0,
    findings: [
      { citation: "Synthetic citation", status: "fake" as const, explanation: "Synthetic finding" },
    ],
  }));
  const db = databasePath ?? path.join(dir, "adminbot.sqlite");
  const app = createAdminBotMockService({
    databasePath: db,
    serviceToken: token,
    sensitiveInfoPath: path.join(dir, "sensitive.md"),
    referenceScanDependencies: { readPdf, scanPdf },
    calendarInviteRunner: async () => {},
  });
  instances.push(app);
  const base = await app.listen(0);
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no listening address");
  }
  const url = base.replace(":0", `:${address.port}`);
  const propose = async () => {
    const response = await fetch(`${url}/reference-scans`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ submission_id: "paper123", notify_email: "reviewer@example.test" }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { proposal: AdminBotStoredProposal; cached: boolean };
  };
  const approve = (proposal: AdminBotStoredProposal) => {
    const result = app.service.approve(proposal.id, {
      payload_hash: proposal.payload_hash,
      approver_role: "admin",
      approver_id: "synthetic-admin",
    });
    expect(result.ok).toBe(true);
  };
  return { app, url, db, readPdf, scanPdf, propose, approve };
}

describe("reference scan MVP", () => {
  it("persists results in the service database and avoids rescans and duplicate notifications", async () => {
    const { app, url, db, scanPdf, propose, approve } = await setup();
    const { proposal } = await propose();
    expect(scanPdf).not.toHaveBeenCalled();
    expect((await propose()).proposal.id).toBe(proposal.id);
    approve(proposal);
    expect((await app.service.execute(proposal.id, { dry_run: false })).ok).toBe(true);
    expect(scanPdf).toHaveBeenCalledTimes(1);
    const { submission_id, pdf_sha256 } = proposal.proposed_payload as {
      submission_id: string;
      pdf_sha256: string;
    };
    const stored = app.store.getReferenceScan(submission_id, pdf_sha256)!;
    expect(stored.status).toBe("completed");
    const response = await fetch(
      `${url}/reference-scans?submission_id=${submission_id}&pdf_sha256=${pdf_sha256}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stored);
    expect(Object.keys(stored).toSorted()).toEqual([
      "pdf_sha256",
      "result",
      "status",
      "submission_id",
    ]);
    expect(app.store.listProposalsByType("email.send")).toHaveLength(1);
    expect((await propose()).cached).toBe(true);
    await app.service.execute(proposal.id, { dry_run: false });
    expect(scanPdf).toHaveBeenCalledTimes(1);
    const reopened = await setup(db);
    expect(reopened.app.store.getReferenceScan(submission_id, pdf_sha256)).toEqual(stored);
    expect((await reopened.propose()).cached).toBe(true);
    expect(reopened.scanPdf).not.toHaveBeenCalled();
  });

  it("requires authentication, approval and the exact payload; dry runs do not scan", async () => {
    const { app, url, scanPdf, propose, approve } = await setup();
    expect((await fetch(`${url}/reference-scans`)).status).toBe(401);
    const { proposal } = await propose();
    expect((await app.service.execute(proposal.id, { dry_run: false })).ok).toBe(false);
    expect(
      app.service.approve(proposal.id, { payload_hash: "wrong", approver_role: "admin" }).ok,
    ).toBe(false);
    expect(
      app.service.approve(proposal.id, {
        payload_hash: proposal.payload_hash,
        approver_role: "member",
      }).ok,
    ).toBe(false);
    approve(proposal);
    await app.service.execute(proposal.id, { dry_run: true });
    expect(scanPdf).not.toHaveBeenCalled();
  });

  it("refuses changed PDFs and proposes the new version separately", async () => {
    const { app, readPdf, scanPdf, propose, approve } = await setup();
    const { proposal } = await propose();
    approve(proposal);
    readPdf.mockResolvedValue({
      submission_id: "paper123",
      title: "Synthetic paper",
      bytes: Buffer.from("%PDF-synthetic-v2"),
    });
    expect((await app.service.execute(proposal.id, { dry_run: false })).ok).toBe(false);
    expect(scanPdf).not.toHaveBeenCalled();
    expect((await propose()).proposal.id).not.toBe(proposal.id);
  });

  it("denies ordinary member sessions on both endpoints", async () => {
    const { app, url, readPdf } = await setup();
    app.service.upsertLabMember({
      id: "synthetic-member",
      name: "Synthetic Member",
      email: "member@example.test",
    });
    const memberToken = "synthetic-member-session";
    app.store.saveSession({
      member_id: "synthetic-member",
      token_hash: createHash("sha256").update(memberToken).digest("hex"),
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${url}/reference-scans`, {
        method,
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      expect(response.status).toBe(403);
    }
    expect(readPdf).not.toHaveBeenCalled();
  });

  it("does not propose mail for a result without flagged citations", async () => {
    const { app, scanPdf, propose, approve } = await setup();
    scanPdf.mockResolvedValue({
      provider_scan_id: "synthetic-result",
      response_version: 1,
      citation_count: 2,
      uncertain_count: 1,
      findings: [],
    });
    const { proposal } = await propose();
    approve(proposal);
    expect((await app.service.execute(proposal.id, { dry_run: false })).ok).toBe(true);
    expect(app.store.listProposalsByType("email.send")).toHaveLength(0);
  });

  it("serializes concurrent execution of the same approved action", async () => {
    const { app, scanPdf, propose, approve } = await setup();
    const { proposal } = await propose();
    approve(proposal);
    await Promise.all([
      app.service.execute(proposal.id, { dry_run: false }),
      app.service.execute(proposal.id, { dry_run: false }),
    ]);
    expect(scanPdf).toHaveBeenCalledTimes(1);
    expect(app.store.listProposalsByType("email.send")).toHaveLength(1);
  });

  it("retries notification proposal creation without repeating a completed scan", async () => {
    const { app, scanPdf, propose, approve } = await setup();
    const { proposal } = await propose();
    approve(proposal);
    const create = vi.spyOn(app.service, "createProposal");
    create.mockReturnValueOnce({ ok: false, status: 503, error: { message: "synthetic failure" } });
    expect((await app.service.execute(proposal.id, { dry_run: false })).ok).toBe(false);
    const { submission_id, pdf_sha256 } = proposal.proposed_payload as {
      submission_id: string;
      pdf_sha256: string;
    };
    expect(app.store.getReferenceScan(submission_id, pdf_sha256)?.status).toBe("completed");
    expect((await app.service.execute(proposal.id, { dry_run: false })).ok).toBe(true);
    expect(scanPdf).toHaveBeenCalledTimes(1);
    expect(app.store.listProposalsByType("email.send")).toHaveLength(1);
  });

  it("records failures without exposing provider errors and permits retry", async () => {
    const { app, scanPdf, propose, approve } = await setup();
    const { proposal } = await propose();
    approve(proposal);
    scanPdf.mockRejectedValueOnce(new Error("secret-provider-response"));
    expect((await app.service.execute(proposal.id, { dry_run: false })).ok).toBe(false);
    const { submission_id, pdf_sha256 } = proposal.proposed_payload as {
      submission_id: string;
      pdf_sha256: string;
    };
    expect(app.store.getReferenceScan(submission_id, pdf_sha256)?.status).toBe("failed");
    expect(JSON.stringify(app.store.getReferenceScan(submission_id, pdf_sha256))).not.toContain(
      "secret-provider-response",
    );
    expect(app.store.listProposalsByType("email.send")).toHaveLength(0);
    expect((await app.service.execute(proposal.id, { dry_run: false })).ok).toBe(true);
    expect(app.store.getReferenceScan(submission_id, pdf_sha256)?.status).toBe("completed");
  });
});
