import { describe, expect, it, vi } from "vitest";
import { AdminBotClient, type FetchLike } from "./client.js";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe("AdminBotClient", () => {
  it("posts proposals to the loopback service with dry-run and env bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "act_1" })) as FetchLike;
    const client = new AdminBotClient(
      {
        serviceBaseUrl: "http://127.0.0.1:8765",
        serviceTokenEnv: "ADMINBOT_TOKEN",
        allowInsecureRemoteService: false,
        defaultDryRun: true,
      },
      fetchImpl,
      { ADMINBOT_TOKEN: "secret-token" },
    );

    await expect(
      client.createProposal({
        type: "social_media.draft",
        summary: "Draft post",
      }),
    ).resolves.toEqual({ id: "act_1" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/proposals",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
        body: JSON.stringify({
          type: "social_media.draft",
          summary: "Draft post",
          dry_run: true,
        }),
      }),
    );
  });

  it("rejects remote service URLs by default", async () => {
    const client = new AdminBotClient({
      serviceBaseUrl: "https://adminbot.example.com",
      allowInsecureRemoteService: false,
      defaultDryRun: true,
    });

    await expect(
      client.createProposal({
        type: "social_media.draft",
        summary: "Draft post",
      }),
    ).rejects.toThrow(/loopback/);
  });

  it("approves by action id and payload hash", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "approved" })) as FetchLike;
    const client = new AdminBotClient(
      {
        serviceBaseUrl: "http://localhost:8765",
        allowInsecureRemoteService: false,
        defaultDryRun: true,
      },
      fetchImpl,
    );

    await client.approve("act_1", {
      payload_hash: "sha256:abc",
      approver_role: "pi",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8765/approvals/act_1/approve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          payload_hash: "sha256:abc",
          approver_role: "pi",
        }),
      }),
    );
  });

  it("lists papers and updates service settings", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as FetchLike;
    const client = new AdminBotClient(
      {
        serviceBaseUrl: "http://localhost:8765",
        allowInsecureRemoteService: false,
        defaultDryRun: true,
      },
      fetchImpl,
    );

    await client.listPapers();
    await client.updateSettings({
      paper_escalation_business_days: 3,
      head_professor_member_id: "zhijing",
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8765/papers",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8765/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          paper_escalation_business_days: 3,
          head_professor_member_id: "zhijing",
        }),
      }),
    );
  });

  it("reads and updates the sensitive-info markdown endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ markdown: "# Sensitive\n" })) as FetchLike;
    const client = new AdminBotClient(
      {
        serviceBaseUrl: "http://localhost:8765",
        allowInsecureRemoteService: false,
        defaultDryRun: true,
      },
      fetchImpl,
    );

    await client.getSensitiveInfo();
    await client.updateSensitiveInfo("# Updated\n");

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8765/sensitive-info",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8765/sensitive-info",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ markdown: "# Updated\n" }),
      }),
    );
  });

  it("surfaces service error messages", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "payload hash mismatch" } }, 409),
    ) as FetchLike;
    const client = new AdminBotClient(
      {
        serviceBaseUrl: "http://localhost:8765",
        allowInsecureRemoteService: false,
        defaultDryRun: true,
      },
      fetchImpl,
    );

    await expect(
      client.execute("act_1", {
        idempotency_key: "idem_1",
      }),
    ).rejects.toThrow("payload hash mismatch");
  });

  // The Gateway only forwards a message to the dashboard when the error is named
  // "ToolInputError"; any other name becomes an opaque "tool execution failed".
  it("names service failures ToolInputError so the Gateway forwards the reason", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "reimbursement workflow is not configured" } }, 503),
    ) as FetchLike;
    const client = new AdminBotClient(
      {
        serviceBaseUrl: "http://localhost:8765",
        allowInsecureRemoteService: false,
        defaultDryRun: true,
      },
      fetchImpl,
    );

    await expect(client.converseReimbursement({ message: "hi" })).rejects.toMatchObject({
      name: "ToolInputError",
      message: expect.stringContaining("reimbursement workflow is not configured"),
    });
  });

  it("reports an unreachable service instead of a bare transport error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as FetchLike;
    const client = new AdminBotClient(
      {
        serviceBaseUrl: "http://127.0.0.1:8765",
        allowInsecureRemoteService: false,
        defaultDryRun: true,
      },
      fetchImpl,
    );

    await expect(client.listPapers()).rejects.toMatchObject({
      name: "ToolInputError",
      message: expect.stringContaining("http://127.0.0.1:8765 is unreachable"),
    });
  });
});
