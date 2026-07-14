import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./mock-service.js";

describe("AdminBot mock service", () => {
  it("serves the management UI and state endpoints", async () => {
    const sensitiveInfoPath = path.join(
      os.tmpdir(),
      `adminbot-sensitive-info-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );
    const mock = createAdminBotMockService({ sensitiveInfoPath });
    await new Promise<void>((resolve, reject) => {
      mock.server.once("error", reject);
      mock.server.listen(0, "127.0.0.1", () => {
        mock.server.off("error", reject);
        resolve();
      });
    });
    const address = mock.server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing mock service address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const ui = await fetch(`${baseUrl}/adminbot`);
      await expect(ui.text()).resolves.toContain("AdminBot Console");

      const settings = await fetch(`${baseUrl}/settings`);
      await expect(settings.json()).resolves.toMatchObject({
        default_privilege_level: "member",
        paper_escalation_business_days: 3,
      });

      const member = await fetch(`${baseUrl}/lab/members/pat`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Pat" }),
      });
      await expect(member.json()).resolves.toMatchObject({
        id: "pat",
        name: "Pat",
        privilege_level: "member",
      });

      const sensitiveInfo = await fetch(`${baseUrl}/sensitive-info`);
      await expect(sensitiveInfo.json()).resolves.toMatchObject({
        path: sensitiveInfoPath,
      });

      const updatedSensitiveInfo = await fetch(`${baseUrl}/sensitive-info`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "# Sensitive\n\n- api key\n- payroll\n" }),
      });
      await expect(updatedSensitiveInfo.json()).resolves.toMatchObject({
        markdown: "# Sensitive\n\n- api key\n- payroll\n",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        mock.server.close((error) => (error ? reject(error) : resolve()));
      });
      mock.close();
      await rm(sensitiveInfoPath, { force: true });
    }
  });
});
