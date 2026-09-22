// POST /lab-papers/relevance: the lab's own papers, ranked against a topic or a proposal.
//
// The assertion that matters most here is the first one. The conference search beside it is on
// ANONYMOUS_ROUTES because it ranks a published programme; this returns our paper titles, so it
// has to refuse an unauthenticated caller. That is the difference between the two routes and it
// is worth a test that fails loudly if anyone ever adds this path to that set.

import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: ReturnType<typeof createAdminBotMockService>[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop();
    if (!mock) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
});

// Two orthogonal directions, so "which paper is this query about" has an unambiguous answer
// without standing up a real embedding model. The controls in lab-relevance.ts fall on the second
// axis, which puts the noise floor at zero and leaves the margin equal to the raw cosine.
const EMBEDDER = vi.fn(async (texts: string[]) =>
  texts.map((text) => (/causal/iu.test(text) ? [1, 0] : [0, 1])),
);

async function startService() {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    embedder: EMBEDDER,
    embeddingModel: "test-model",
    sensitiveInfoPath: path.join(
      os.tmpdir(),
      `adminbot-lab-papers-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    ),
  });
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
  running.push(mock);
  for (const [id, title] of [
    ["causal-scientist", "Causal AI Scientist"],
    ["optimal-transport", "Optimal Transport for Everything"],
  ]) {
    const saved = mock.service.upsertPaper({
      id,
      title,
      authors: ["Ada"],
      current_step: "overleaf_writing",
    });
    expect(saved.ok).toBe(true);
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" };
}

async function rank(baseUrl: string, body: unknown, auth = true) {
  return fetch(`${baseUrl}/lab-papers/relevance`, {
    method: "POST",
    headers: auth ? headers() : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /lab-papers/relevance", () => {
  it("refuses an unauthenticated caller, unlike the conference search beside it", async () => {
    const { baseUrl } = await startService();
    const response = await rank(baseUrl, { query: "causality" }, false);
    expect(response.status).toBe(401);
  });

  it("asks for a query rather than ranking against nothing", async () => {
    const { baseUrl } = await startService();
    const response = await rank(baseUrl, { query: "   " });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("say what to look for");
  });

  it("ranks the lab's own papers and leaves the unrelated one out", async () => {
    const { baseUrl } = await startService();
    const response = await rank(baseUrl, { query: "causality" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      query_kind: string;
      scored: number;
      matches: Array<{ paper_id: string; band: string; evidence: string }>;
      off_topic: Array<{ paper_id: string }>;
      nothing_relevant: boolean;
    };
    expect(body.query_kind).toBe("keywords");
    expect(body.scored).toBe(2);
    expect(body.matches.map((match) => match.paper_id)).toEqual(["causal-scientist"]);
    expect(body.off_topic.map((match) => match.paper_id)).toEqual(["optimal-transport"]);
    // Every row says how thin the record behind it was; these carry titles and nothing else.
    expect(body.matches[0]?.evidence).toBe("title_only");
    expect(body.nothing_relevant).toBe(false);
  });

  it("splits a pasted proposal into its own sections", async () => {
    const { baseUrl } = await startService();
    const response = await rank(baseUrl, {
      query: [
        "# Causal representation learning",
        "Recovering structure.",
        "",
        "# Compute governance",
        "Reporting thresholds.",
      ].join("\n"),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { query_kind: string; segment_count: number };
    expect(body.query_kind).toBe("proposal");
    expect(body.segment_count).toBe(2);
  });
});
