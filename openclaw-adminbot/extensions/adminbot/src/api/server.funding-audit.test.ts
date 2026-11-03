import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fundingInput } from "../workflows/papers/funding-audit.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

function invokeCli(
  args: string[],
  input: unknown,
  baseUrl: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../cli/adminbot.mjs", import.meta.url)), ...args, "--file", "-"],
      {
        env: { ADMINBOT_URL: baseUrl, ADMINBOT_TOKEN: "synthetic-cli" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("funding audit CLI to real proposal route", () => {
  it("returns server-computed per-funder findings without executing external effects", async () => {
    const mock = createAdminBotMockService({
      serviceToken: "synthetic-cli",
      calendarInviteRunner: async () => {},
    });
    await new Promise<void>((resolve) => {
      mock.server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = mock.server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing address");
      }
      const input = fundingInput();
      input.sources = input.sources.map((source) => ({
        ...source,
        checkedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }));
      const before = mock.store.listProposalsByType("paper.overleaf_edit").length;
      const {
        code: previewCode,
        out: previewOut,
        err: previewErr,
      } = await invokeCli(["papers", "funding-audit"], input, `http://127.0.0.1:${address.port}`);
      expect(previewErr).toBe("");
      expect(previewCode).toBe(0);
      expect(JSON.parse(previewOut)).toMatchObject({
        findings: [{ id: "grant-a", decision: "include" }],
        preservedCredits: input.existingCredits,
      });
      expect(mock.store.listProposalsByType("paper.overleaf_edit")).toHaveLength(before);
      const denied = await fetch(`http://127.0.0.1:${address.port}/papers/funding-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(denied.status).toBe(401);
      const malformed = await fetch(`http://127.0.0.1:${address.port}/papers/funding-audit`, {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-cli", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(malformed.status).toBe(400);
      const body = {
        type: "paper.overleaf_edit",
        summary: "Synthetic acknowledgement audit",
        proposed_payload: {
          action: "apply_overleaf_project_edits",
          mode: "funding_check",
          paper: input.paper,
          requestedEdits: "Review candidate credit, preserve independent coauthor support.",
          targetFiles: ["main.tex"],
          fundingAudit: { input, findings: [{ id: "forged", decision: "exclude" }] },
        },
      };
      const { code, out, err } = await invokeCli(
        ["proposals", "create"],
        body,
        `http://127.0.0.1:${address.port}`,
      );
      expect(err).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(out);
      expect(result).toMatchObject({
        status: "pending",
        risk_tier: "T4",
        approval_requirement: { min_approvals: 2 },
        proposed_payload: {
          fundingAudit: {
            findings: [{ id: "grant-a", decision: "include" }],
            preservedCredits: input.existingCredits,
          },
        },
      });
    } finally {
      mock.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        mock.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
