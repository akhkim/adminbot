import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminBotMockService } from "./server.js";

const running: ReturnType<typeof createAdminBotMockService>[] = [];
afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );
    mock.close();
  }
});
async function start(options: Parameters<typeof createAdminBotMockService>[0] = {}) {
  const mock = createAdminBotMockService({ serviceToken: "synthetic-token", ...options });
  running.push(mock);
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const address = mock.server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return { mock, url: `http://127.0.0.1:${address.port}/members/personal-website-reminder/run` };
}

describe("personal website reminder route", () => {
  it("refuses anonymous callers", async () => {
    const { url } = await start();
    expect([401, 403]).toContain((await fetch(url, { method: "POST" })).status);
  });
  it("does not let member sessions forge a scheduled send", async () => {
    const { mock, url } = await start();
    const admin = { id: "admin", name: "Synthetic Admin", privilege_level: "admin" as const };
    const member = { id: "member", name: "Synthetic Member", privilege_level: "member" as const };
    mock.service.upsertLabMember(admin);
    mock.service.upsertLabMember(member);
    const session = vi.spyOn(mock.auth, "resolveSession");
    session.mockResolvedValue({ kind: "member", member });
    const request = () =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-session", "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: false, scheduled: true }),
      });
    expect((await request()).status).toBe(403);
    session.mockResolvedValue({ kind: "member", member: admin });
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ refused: "confirm_required" });
  });
  it("previews by default and ignores arbitrary recipients and message text", async () => {
    const { mock, url } = await start();
    mock.service.upsertLabMember({
      id: "ada",
      name: "Ada",
      status: "active",
      receives_nudges: true,
      slack_user_id: "U-SYNTHETIC",
    });
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" },
      body: JSON.stringify({ message: "attacker text", recipients: ["evil"], scheduled: true }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ dry_run: true, count: 1 });
    expect(result.samples[0].message).toContain("personal webpage");
    expect(result.samples[0].message).not.toContain("attacker text");
  });
});
