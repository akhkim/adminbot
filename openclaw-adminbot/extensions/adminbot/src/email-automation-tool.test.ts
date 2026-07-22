import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminBotClient } from "./client.js";
import { createAdminBotMockService } from "./mock-service.js";

const openServices: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  for (const service of openServices.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      service.server.close((error) => (error ? reject(error) : resolve()));
    });
    service.close();
  }
});

describe("AdminBot email automation tool service", () => {
  it("awaits one run and returns its terminal summary to concurrent callers", async () => {
    const summary = {
      found: 4,
      completed: 2,
      failed: 1,
      needs_review: 1,
      skipped: 0,
      errors: ["m4: model timeout"],
    };
    const runner = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return summary;
    });
    const service = createAdminBotMockService({ emailAutomationRunner: runner });
    openServices.push(service);
    await service.listen(0, "127.0.0.1");
    const address = service.server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing AdminBot service address");
    }
    const baseUrl = "http://127.0.0.1:" + address.port;
    const client = new AdminBotClient({
      serviceBaseUrl: baseUrl,
      allowInsecureRemoteService: false,
      defaultDryRun: false,
    });

    await expect(
      Promise.all([client.runEmailAutomation(), client.runEmailAutomation()]),
    ).resolves.toEqual([summary, summary]);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("reports an unavailable runner instead of pretending work started", async () => {
    const service = createAdminBotMockService();
    openServices.push(service);
    await service.listen(0, "127.0.0.1");
    const address = service.server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing AdminBot service address");
    }
    const baseUrl = "http://127.0.0.1:" + address.port;
    const client = new AdminBotClient({
      serviceBaseUrl: baseUrl,
      allowInsecureRemoteService: false,
      defaultDryRun: false,
    });

    await expect(client.runEmailAutomation()).rejects.toThrow(
      "email automation runner is not configured",
    );
  });
});
