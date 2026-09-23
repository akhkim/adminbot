import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfReferenceChecker } from "../connectors/reference-check.js";
import type { OpenReviewSubmissionReader } from "../contracts/openreview-citation-checks.js";
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

async function setup(options: { configured?: boolean; databasePath?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-citation-checks-"));
  dirs.push(dir);
  const reader: OpenReviewSubmissionReader = {
    profileId: async () => "~Synthetic_Author1",
    listSubmissions: vi.fn(async () => [
      {
        id: "paperAAAA",
        title: "Synthetic paper",
        venue_id: "Synthetic.cc/2027/Conference/Submission",
        pdf_path: "/pdf/v1.pdf",
        modified_at: 1,
      },
    ]),
    readPdf: vi.fn(async () => Buffer.from("%PDF-synthetic")),
  };
  const check = vi.fn<PdfReferenceChecker>(async () => ({
    findings: [
      {
        citation: "Synthetic B. A paper nobody wrote. 2031.",
        status: "not_found" as const,
        explanation: "No matching reference found in the available databases.",
      },
    ],
  }));
  const databasePath = options.databasePath ?? path.join(dir, "adminbot.sqlite");
  const app = createAdminBotMockService({
    databasePath,
    serviceToken: token,
    sensitiveInfoPath: path.join(dir, "sensitive.md"),
    calendarInviteRunner: async () => {},
    ...(options.configured === false
      ? {}
      : {
          openReviewSubmissionReader: reader,
          citationWatchChecker: check,
          citationWatchNotifyEmail: "lab-admin@example.test",
        }),
  });
  instances.push(app);
  const base = await app.listen(0);
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no listening address");
  }
  const url = base.replace(":0", `:${address.port}`);
  const call = (route: string, init: RequestInit = {}, auth = true) =>
    fetch(`${url}${route}`, {
      ...init,
      headers: auth ? { Authorization: `Bearer ${token}` } : {},
    });
  return { app, url, dir, databasePath, reader, check, call };
}

/** A member session at the given privilege, through the real claim/approve/login path. */
async function sessionFor(
  app: ReturnType<typeof createAdminBotMockService>,
  url: string,
  id: string,
  privilege: "admin" | "member",
): Promise<string> {
  const email = `${id}@example.test`;
  const seeded = app.service.upsertLabMember({ id, name: id, email, privilege_level: privilege });
  if (!seeded.ok) {
    throw new Error(seeded.error.message);
  }
  const json = { "Content-Type": "application/json" };
  await fetch(`${url}/auth/claim`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ member_id: id, email, password: "correcthorse" }),
  });
  const pending = (await (
    await fetch(`${url}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { registrations: Array<{ id: string; member_id?: string }> };
  const registration = pending.registrations.find((entry) => entry.member_id === id)!;
  expect(app.auth.approveRegistration(registration.id, "synthetic-admin").ok).toBe(true);
  const login = await fetch(`${url}/auth/login`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  return ((await login.json()) as { session_token: string }).session_token;
}

describe("OpenReview citation check routes", () => {
  it("starts a sweep, stores the result and lists it for admins", async () => {
    const { app, check, call } = await setup();
    const run = await call("/openreview/citation-checks/run", { method: "POST" });
    expect(run.status).toBe(202);
    expect(await run.json()).toMatchObject({ started: true, submissions: 1, pending: 1 });

    await vi.waitFor(async () => {
      const listed = (await (await call("/openreview/citation-checks")).json()) as {
        running: boolean;
        checks: unknown[];
      };
      expect(listed.running).toBe(false);
      expect(listed.checks).toHaveLength(1);
    });
    const listed = await (await call("/openreview/citation-checks")).json();
    expect(listed).toMatchObject({
      enabled: true,
      notify_email: "lab-admin@example.test",
      last_sweep: { checked: 1, flagged: 1 },
      checks: [{ submission_id: "paperAAAA", pdf_path: "/pdf/v1.pdf", status: "completed" }],
    });
    // The finding becomes an email proposal awaiting approval, not a sent message.
    const proposals = app.store.listProposalsByType("email.send");
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("pending");

    // Rerunning is harmless: the version is already checked.
    const again = await call("/openreview/citation-checks/run", { method: "POST" });
    expect(await again.json()).toMatchObject({ started: true, pending: 0 });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("keeps results across a restart, so no version is checked twice", async () => {
    const first = await setup();
    await first.call("/openreview/citation-checks/run", { method: "POST" });
    await vi.waitFor(() => expect(first.app.store.listOpenReviewCitationChecks()).toHaveLength(1));
    const second = await setup({ databasePath: first.databasePath });
    const run = await second.call("/openreview/citation-checks/run", { method: "POST" });
    expect(await run.json()).toMatchObject({ pending: 0 });
    expect(second.check).not.toHaveBeenCalled();
  });

  it("answers 503 while the deployment has not opted in", async () => {
    const { call } = await setup({ configured: false });
    const run = await call("/openreview/citation-checks/run", { method: "POST" });
    expect(run.status).toBe(503);
    expect((await run.json()).error.message).toContain("ADMINBOT_OPENREVIEW_CITATION_CHECKS=1");
    const listed = await call("/openreview/citation-checks");
    expect(await listed.json()).toMatchObject({ enabled: false, running: false, checks: [] });
  });

  it("refuses unauthenticated callers", async () => {
    const { call, reader } = await setup();
    expect((await call("/openreview/citation-checks", {}, false)).status).toBe(401);
    expect((await call("/openreview/citation-checks/run", { method: "POST" }, false)).status).toBe(
      401,
    );
    expect(reader.listSubmissions).not.toHaveBeenCalled();
  });

  it("lets admin sessions read results and refuses ordinary members", async () => {
    const { app, url, reader } = await setup();
    const admin = await sessionFor(app, url, "adminsynth", "admin");
    const member = await sessionFor(app, url, "membersynth", "member");
    const as = (session: string, route: string, method = "GET") =>
      fetch(`${url}${route}`, { method, headers: { Authorization: `Bearer ${session}` } });
    expect((await as(member, "/openreview/citation-checks")).status).toBe(403);
    expect((await as(member, "/openreview/citation-checks/run", "POST")).status).toBe(403);
    expect(reader.listSubmissions).not.toHaveBeenCalled();
    expect((await as(admin, "/openreview/citation-checks")).status).toBe(200);
  });

  it("reports an OpenReview login failure as a server error", async () => {
    const { call, reader } = await setup();
    vi.mocked(reader.listSubmissions).mockRejectedValueOnce(
      new Error("OpenReview rejected the login (403) — check OPENREVIEW_USERNAME/PASSWORD"),
    );
    const run = await call("/openreview/citation-checks/run", { method: "POST" });
    // 502 in the service; sendJson sends it as 500 once #283's tunnel-safe mapping is present.
    expect([500, 502]).toContain(run.status);
    expect((await run.json()).error.message).toContain("rejected the login");
  });
});
