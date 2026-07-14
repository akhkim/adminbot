import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "./contracts.js";
import { createAdminBotOverleafExecutor, type OverleafFetch } from "./overleaf-executor.js";

function proposal(payload: unknown): AdminBotStoredProposal {
  return {
    id: "act_1",
    type: "paper.overleaf_edit",
    risk_tier: "T4",
    summary: "Edit Overleaf paper",
    proposed_payload: payload,
    payload_hash: "sha256:test",
    status: "approved",
    approval_requirement: { requires_approval: true, approver_roles: ["pi"], min_approvals: 1 },
    approvals: [{ approver_role: "pi" }],
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
  };
}

describe("AdminBot Overleaf executor", () => {
  it("posts approved Overleaf edit payloads to the configured bridge endpoint", async () => {
    const calls: Array<{ url: string; body?: unknown; headers?: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(init.body) : undefined,
        headers: init?.headers,
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify({ ok: true });
        },
      };
    }) as OverleafFetch;
    const executor = createAdminBotOverleafExecutor({
      fetchImpl,
      env: {
        OVERLEAF_API_BASE_URL: "https://overleaf-bridge.example/api/",
        OVERLEAF_ACCESS_TOKEN: "token",
      },
    });

    await expect(
      executor.execute(
        proposal({
          action: "apply_overleaf_project_edits",
          mode: "manual",
          paper: {
            title: "Paper",
            authors: ["Pat"],
            overleafEditUrl: "https://www.overleaf.com/project/abc",
          },
          requestedEdits: "Fix typo.",
          targetFiles: ["main.tex"],
        }),
      ),
    ).resolves.toEqual({ handled: true });

    expect(calls).toEqual([
      {
        url: "https://overleaf-bridge.example/api/project-edits",
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
        body: expect.objectContaining({ action: "apply_overleaf_project_edits" }),
      },
    ]);
  });

  it("fails closed when affiliation issues still need confirmation", async () => {
    const executor = createAdminBotOverleafExecutor({
      fetchImpl: vi.fn() as OverleafFetch,
      env: {
        OVERLEAF_API_BASE_URL: "https://overleaf-bridge.example/api",
        OVERLEAF_ACCESS_TOKEN: "token",
      },
    });

    await expect(
      executor.execute(
        proposal({
          action: "apply_overleaf_project_edits",
          mode: "affiliation_check",
          paper: {
            title: "Paper",
            authors: ["Pat"],
            overleafEditUrl: "https://www.overleaf.com/project/abc",
          },
          requestedEdits: "Fix affiliations.",
          targetFiles: ["main.tex"],
          affiliationPolicy: {
            source: "affiliation-policy.md",
            rules: [],
            issues: [{ author: "Pat", status: "confirm", message: "Need exact affiliation." }],
          },
        }),
      ),
    ).rejects.toThrow(/requires confirmation/u);
  });
});
