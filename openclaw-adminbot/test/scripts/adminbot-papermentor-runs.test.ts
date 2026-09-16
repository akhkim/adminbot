// The collector's walk: which cached reviews it reports, and what it does with the odd ones.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotPaperMentorRunInput } from "../../extensions/adminbot/src/contracts/papermentor.js";
import {
  collectPaperMentorRuns,
  createPaperMentorPoster,
  type PaperMentorRunOutcome,
} from "../../scripts/adminbot-papermentor-runs.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function review(projectId: string, reviewedAt: string, comments = 2) {
  return {
    projectId,
    model: "gpt-5.2-chat-latest",
    reviewedAt,
    classification: { paperType: "method_improvement", paperTypeSummary: "prose about the paper" },
    commentsByDoc: {
      "main.tex": Array.from({ length: comments }, (_, index) => ({
        highlightText: `secret sentence ${index}`,
        comment: `[AI Tutor] [warning] [results] a comment nobody outside should see ${index}`,
        severity: "warning",
        category: "results",
      })),
    },
    summary: {
      total: comments,
      byCategory: { results: comments },
      bySeverity: { warning: comments },
    },
    failedAgents: [],
  };
}

/** A cache directory shaped like PaperMentor's own. */
function cacheWith(entries: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-papermentor-"));
  dirs.push(root);
  for (const [projectId, content] of Object.entries(entries)) {
    const dir = path.join(root, projectId);
    fs.mkdirSync(dir, { recursive: true });
    // `undefined` is a project the panel opened but never reviewed: a directory with merged
    // sources in it and no review file, which is most of them.
    if (content !== undefined) {
      fs.writeFileSync(
        path.join(dir, "review_comments.json"),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    fs.writeFileSync(path.join(dir, "merged.tex"), "\\documentclass{article}");
  }
  return root;
}

function recorder() {
  const posted: AdminBotPaperMentorRunInput[] = [];
  const post = async (run: AdminBotPaperMentorRunInput) => {
    posted.push(run);
    return { outcome: "recorded" as PaperMentorRunOutcome };
  };
  return { posted, post };
}

describe("collectPaperMentorRuns", () => {
  it("posts one summary per cached review, and skips projects with none", async () => {
    const cacheDir = cacheWith({
      "65f2a1c9d4e3b7a801f6": review("65f2a1c9d4e3b7a801f6", "2026-09-12T11:04:09.221Z", 3),
      "70aa1c9d4e3b7a801f60": undefined,
    });
    const { posted, post } = recorder();

    const summary = await collectPaperMentorRuns({ cacheDir, post, log: () => {} });

    expect(summary).toMatchObject({ recorded: 1, unreadable: 0, failed: 0 });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      project_id: "65f2a1c9d4e3b7a801f6",
      reviewed_at: "2026-09-12T11:04:09.221Z",
      comments_total: 3,
    });
  });

  // The collector runs on the machine that holds the papers, and this is the promise that nothing
  // of the paper leaves it. Asserted here as well as on the summarizer because this is the point
  // where a file on disk becomes a network request.
  it("sends counts and no prose, whatever the cached review contains", async () => {
    const cacheDir = cacheWith({
      "65f2a1c9d4e3b7a801f6": review("65f2a1c9d4e3b7a801f6", "2026-09-12T11:04:09.221Z"),
    });
    const { posted, post } = recorder();

    await collectPaperMentorRuns({ cacheDir, post, log: () => {} });

    const wire = JSON.stringify(posted);
    expect(wire).not.toContain("secret sentence");
    expect(wire).not.toContain("nobody outside should see");
    expect(wire).not.toContain("prose about the paper");
  });

  it("counts a half-written or unknown file rather than stopping the pass", async () => {
    const cacheDir = cacheWith({
      "65f2a1c9d4e3b7a801f6": '{"projectId": "65f2a1c9d4e3',
      "70aa1c9d4e3b7a801f60": { nothing: "like a review" },
      "81bb1c9d4e3b7a801f61": review("81bb1c9d4e3b7a801f61", "2026-09-12T11:04:09.221Z"),
    });
    const { posted, post } = recorder();

    const summary = await collectPaperMentorRuns({ cacheDir, post, log: () => {} });

    expect(summary).toMatchObject({ recorded: 1, unreadable: 2 });
    expect(posted.map((run) => run.project_id)).toEqual(["81bb1c9d4e3b7a801f61"]);
  });

  it("leaves reviews older than the floor alone, so a first pass is not a year of news", async () => {
    const cacheDir = cacheWith({
      "65f2a1c9d4e3b7a801f6": review("65f2a1c9d4e3b7a801f6", "2025-01-04T09:00:00.000Z"),
      "70aa1c9d4e3b7a801f60": review("70aa1c9d4e3b7a801f60", "2026-09-12T11:04:09.221Z"),
    });
    const { posted, post } = recorder();

    await collectPaperMentorRuns({
      cacheDir,
      post,
      since: new Date("2026-01-01T00:00:00.000Z"),
      log: () => {},
    });

    expect(posted.map((run) => run.project_id)).toEqual(["70aa1c9d4e3b7a801f60"]);
  });
});

describe("createPaperMentorPoster", () => {
  const run: AdminBotPaperMentorRunInput = {
    project_id: "65f2a1c9d4e3b7a801f6",
    reviewed_at: "2026-09-12T11:04:09.221Z",
    comments_total: 2,
    by_severity: { warning: 2 },
    by_category: { results: 2 },
    by_document: [{ path: "main.tex", comments: 2 }],
    failed_agents: [],
  };

  const respond = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  it("separates a new review from one already on file", async () => {
    const post = createPaperMentorPoster({
      baseUrl: "https://adminbot.example/",
      token: "t",
      fetchImpl: async () => respond(200, { paper_id: "p1", recorded: true }),
    });
    expect((await post(run)).outcome).toBe("recorded");

    const repeat = createPaperMentorPoster({
      baseUrl: "https://adminbot.example",
      token: "t",
      fetchImpl: async () => respond(200, { paper_id: "p1", recorded: false }),
    });
    expect((await repeat(run)).outcome).toBe("known");
  });

  // A paper nobody registered is a fact about the lab, not a broken pass: it is reported and the
  // run still exits zero, so the cron history does not go red for something no retry will fix.
  it("reads a 404 as a paper nobody has registered", async () => {
    const post = createPaperMentorPoster({
      baseUrl: "https://adminbot.example",
      token: "t",
      fetchImpl: async () => respond(404, { error: { message: "no paper on file" } }),
    });

    const result = await post(run);
    expect(result.outcome).toBe("unmatched");
    expect(result.note).toContain("65f2a1c9d4e3b7a801f6");
  });

  it("reads an unreachable service as a failure", async () => {
    const post = createPaperMentorPoster({
      baseUrl: "https://adminbot.example",
      token: "t",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    expect((await post(run)).outcome).toBe("failed");
  });
});
