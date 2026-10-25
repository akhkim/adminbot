// POST /papers/linkedin-draft with a PDF attached in the body.
//
// An attached PDF is the way through when the service cannot read the card's Drive copy, so the
// route has to take a real paper's worth of base64 -- well past the 1 MB default every other JSON
// route keeps.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkedInDraftRequest } from "../connectors/social-draft.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: Array<{ mock: ReturnType<typeof createAdminBotMockService>; cleanup: string }> = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    await rm(entry.cleanup, { force: true });
  }
});

async function start(): Promise<{
  baseUrl: string;
  requests: LinkedInDraftRequest[];
  arxivReads: string[];
  mock: ReturnType<typeof createAdminBotMockService>;
}> {
  const requests: LinkedInDraftRequest[] = [];
  const arxivReads: string[] = [];
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-linkedin-draft-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    readArxivPdfBase64: async (id) => {
      arxivReads.push(id);
      return "YXJ4aXY=";
    },
    linkedInDraftRunner: async (request) => {
      requests.push(request);
      return {
        paper: { title: "A paper", authors: [], abstract: "An abstract." },
        text: "A draft.",
        model: "test/model",
        issues: [],
        authors: [],
      };
    },
    xDraftRunner: async (request) => {
      requests.push(request);
      return {
        paper: { title: "Paper", authors: [], abstract: "Evidence." },
        posts: [{ text: "1/2 Question" }, { text: "2/2 Finding" }],
        model: "test/model",
        issues: [],
        authors: [],
      };
    },
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
    throw new Error("missing service address");
  }
  running.push({ mock, cleanup: sensitiveInfoPath });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, arxivReads, mock };
}

async function draft(baseUrl: string, pdfBase64: string): Promise<number> {
  const res = await fetch(`${baseUrl}/papers/linkedin-draft`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pdf_base64: pdfBase64, paper_id: "p1" }),
  });
  await res.text();
  return res.status;
}

describe("POST /papers/linkedin-draft", () => {
  it("exposes a separate authenticated X draft endpoint", async () => {
    const { baseUrl, requests } = await start();
    const anonymous = await fetch(`${baseUrl}/papers/x-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);
    const response = await fetch(`${baseUrl}/papers/x-draft`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_base64: "cGRm" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      posts: [{ text: "1/2 Question" }, { text: "2/2 Finding" }],
    });
    expect(requests).toHaveLength(1);
  });
  it("takes an attached PDF far larger than the default JSON ceiling", async () => {
    const { baseUrl, requests } = await start();
    const pdfBase64 = Buffer.alloc(5 * 1024 * 1024, 1).toString("base64");

    expect(await draft(baseUrl, pdfBase64)).toBe(200);
    // The attached file is what reaches the model, not the card's Drive copy.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pdfBase64).toBe(pdfBase64);
  });

  it("still refuses a body past the 20 MB PDF ceiling", async () => {
    const { baseUrl, requests } = await start();
    const pdfBase64 = Buffer.alloc(21 * 1024 * 1024, 1).toString("base64");

    expect(await draft(baseUrl, pdfBase64)).toBe(413);
    expect(requests).toHaveLength(0);
  });
});

const ABSTRACT =
  "We study pruning for retrieval-augmented models and show that grounding-aware pruning keeps " +
  "accuracy while removing most of the retrieved context. Across six benchmarks the method " +
  "matches the unpruned model at a fraction of the cost.";

function seedPaper(
  mock: ReturnType<typeof createAdminBotMockService>,
  artifacts: Record<string, string> = {},
): void {
  const saved = mock.service.upsertPaper({
    id: "p1",
    title: "PruneGround",
    authors: ["Mina Member", "Outside Author"],
    current_step: "submission",
    artifacts,
  });
  if (!saved.ok) {
    throw new Error(saved.error.message);
  }
}

async function post(baseUrl: string, route: string, body: unknown) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { error?: { message?: string } } };
}

describe("draft sources beyond an uploaded PDF", () => {
  it("reads the arXiv PDF from the card's own link when no slot holds one", async () => {
    const { baseUrl, requests, arxivReads, mock } = await start();
    seedPaper(mock, { arxiv_url: "https://arxiv.org/abs/2610.01234" });
    for (const route of ["/papers/x-draft", "/papers/linkedin-draft"]) {
      const response = await post(baseUrl, route, { paper_id: "p1" });
      expect(response.status).toBe(200);
    }
    expect(arxivReads).toEqual(["2610.01234", "2610.01234"]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://arxiv.org/abs/2610.01234",
      "https://arxiv.org/abs/2610.01234",
    ]);
  });

  it("drafts from a pasted abstract with the card's title and author order", async () => {
    const { baseUrl, requests, arxivReads, mock } = await start();
    seedPaper(mock);
    const response = await post(baseUrl, "/papers/x-draft", { paper_id: "p1", abstract: ABSTRACT });
    expect(response.status).toBe(200);
    expect(arxivReads).toEqual([]);
    expect(requests[0]?.source).toEqual({
      title: "PruneGround",
      authors: ["Mina Member", "Outside Author"],
      abstract: ABSTRACT,
    });
    expect(requests[0]?.pdfBase64).toBe("");
  });

  it("refuses a pasted abstract too short to ground a post, saying so", async () => {
    const { baseUrl, requests, mock } = await start();
    seedPaper(mock);
    const response = await post(baseUrl, "/papers/x-draft", { paper_id: "p1", abstract: "Short." });
    expect(response.status).toBe(400);
    expect(response.json.error?.message).toContain("paste the whole abstract");
    expect(requests).toHaveLength(0);
  });

  it("names every way out when the paper has no PDF anywhere", async () => {
    const { baseUrl, requests, mock } = await start();
    seedPaper(mock);
    const response = await post(baseUrl, "/papers/linkedin-draft", { paper_id: "p1" });
    expect(response.status).toBe(400);
    expect(response.json.error?.message).toContain("paste the abstract");
    expect(requests).toHaveLength(0);
  });
});
