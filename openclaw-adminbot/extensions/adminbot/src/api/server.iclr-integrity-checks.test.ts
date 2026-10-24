import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenReviewSubmissionReader } from "../contracts/openreview-citation-checks.js";
import type { AiTextScorer } from "../contracts/paper-integrity-checks.js";
import { createAdminBotMockService } from "./server.js";

const token = "synthetic-service-token";
const instances: ReturnType<typeof createAdminBotMockService>[] = [];
const dirs: string[] = [];
beforeEach(() => {
  // Independent of the wall clock: the built-in default cutoff is a real date.
  vi.stubEnv("ADMINBOT_ICLR_INTEGRITY_UNTIL", "2999-01-01T00:00:00Z");
});

afterEach(async () => {
  vi.unstubAllEnvs();
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-integrity-checks-"));
  dirs.push(dir);
  const reader: OpenReviewSubmissionReader = {
    profileId: async () => "~Synthetic_Author1",
    listSubmissions: vi.fn(async () => [
      {
        id: "paperAAAA",
        title: "Synthetic paper",
        venue_id: "ICLR.cc/2027/Conference/Submission",
        pdf_path: "/pdf/v1.pdf",
        modified_at: 1,
        author_ids: ["~Synthetic_Author1"],
      },
    ]),
    readPdf: vi.fn(async () => Buffer.from("%PDF-synthetic")),
  };
  const score = vi.fn<AiTextScorer>(async () => ({
    fraction_ai: 0.3,
    fraction_ai_assisted: 0.1,
    fraction_human: 0.6,
    prediction: "Mixed",
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
          aiTextScorer: score,
          integrityTextExtractor: async () =>
            Array.from({ length: 500 }, (_, index) => `word${index}`).join(" "),
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
  return { app, databasePath, score, call };
}

describe("ICLR integrity check routes", () => {
  it("starts a sweep and lists the stored score, surviving a restart", async () => {
    const { app, databasePath, score, call } = await setup();
    const run = await call("/openreview/integrity-checks/run", { method: "POST" });
    expect(run.status).toBe(202);
    expect(await run.json()).toMatchObject({ started: true, submissions: 1, pending: 1 });

    await vi.waitFor(async () => {
      const listed = (await (await call("/openreview/integrity-checks")).json()) as {
        running: boolean;
        checks: unknown[];
      };
      expect(listed.running).toBe(false);
      expect(listed.checks).toHaveLength(1);
    });
    expect(score).toHaveBeenCalledTimes(1);
    expect(app.store.listPaperAiTextChecks()).toHaveLength(1);

    const reopened = await setup({ databasePath });
    const listed = (await (await reopened.call("/openreview/integrity-checks")).json()) as {
      enabled: boolean;
      threshold: number;
      checks: unknown[];
    };
    expect(listed).toMatchObject({ enabled: true, threshold: 0.5 });
    expect(listed.checks).toEqual([
      expect.objectContaining({
        submission_id: "paperAAAA",
        status: "completed",
        fraction_ai: 0.3,
        fraction_ai_assisted: 0.1,
        prediction: "Mixed",
        words_scored: 500,
      }),
    ]);
  });

  it("stops for good once the cutoff has passed", async () => {
    vi.stubEnv("ADMINBOT_ICLR_INTEGRITY_UNTIL", "2020-01-01T00:00:00Z");
    const { score, call } = await setup();
    const run = await call("/openreview/integrity-checks/run", { method: "POST" });
    expect(run.status).toBe(202);
    expect(await run.json()).toMatchObject({
      started: false,
      ended_at: "2020-01-01T00:00:00.000Z",
    });
    expect(score).not.toHaveBeenCalled();
  });

  it("answers 503 naming the settings when the check is off", async () => {
    const { call } = await setup({ configured: false });
    const run = await call("/openreview/integrity-checks/run", { method: "POST" });
    expect(run.status).toBe(503);
    expect(JSON.stringify(await run.json())).toContain("PANGRAM_API_KEY");
  });

  it("refuses an unauthenticated caller", async () => {
    const { call } = await setup();
    expect((await call("/openreview/integrity-checks", {}, false)).status).toBe(401);
    expect((await call("/openreview/integrity-checks/run", { method: "POST" }, false)).status).toBe(
      401,
    );
  });
});
