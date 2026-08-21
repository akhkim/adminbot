import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenReviewPaper } from "../connectors/openreview-notes.js";
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

async function startService(options: Parameters<typeof createAdminBotMockService>[0] = {}) {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath: path.join(
      os.tmpdir(),
      `adminbot-venue-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    ),
    ...options,
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
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" };
}

function paper(id: string, title: string, keywords: string[] = []): OpenReviewPaper {
  return {
    id,
    title,
    abstract: `Abstract of ${title}`,
    keywords,
    venue: "ICLR 2025 Poster",
    pdf_url: `https://openreview.net/pdf/${id}.pdf`,
    forum_url: `https://openreview.net/forum?id=${id}`,
  };
}

const SAFETY = paper("p-safe", "On Alignment", ["AI safety"]);
const TRANSPORT = paper("p-ot", "Optimal Transport", ["optimal transport"]);

// Two orthogonal directions, so "which paper does this query match" has an unambiguous answer
// without depending on a real embedding model.
function stubEmbedder(map: Record<string, number[]>, fallback = [0, 1]) {
  return vi.fn(async (texts: string[]) =>
    texts.map((text) => {
      const hit = Object.entries(map).find(([needle]) => text.includes(needle));
      return hit ? hit[1] : fallback;
    }),
  );
}

const EMBEDDER = stubEmbedder({
  "On Alignment": [1, 0],
  "AI safety": [1, 0],
  "Optimal Transport": [0.05, 1],
});

async function withVenue(papers: OpenReviewPaper[] = [SAFETY, TRANSPORT]) {
  const { baseUrl, mock } = await startService({
    venuePapersReader: async () => papers,
    embedder: EMBEDDER,
    embeddingModel: "test-model",
  });
  // Through the service rather than over HTTP: PUT /settings needs a real admin *member* session,
  // which this suite has no reason to stand up just to name a conference.
  const saved = mock.service.updateSettings({
    venue_sources: [{ id: "ICLR.cc/2025/Conference", label: "ICLR 2025" }],
  });
  expect(saved.ok).toBe(true);
  return { baseUrl, mock };
}

describe("GET /venue-papers/sources", () => {
  it("lists the configured conferences and says none is indexed yet", async () => {
    const { baseUrl } = await withVenue();
    const response = await fetch(`${baseUrl}/venue-papers/sources`, { headers: headers() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sources: Array<{ venue_id: string; label: string; paper_count: number }>;
    };
    expect(body.sources).toEqual([
      { venue_id: "ICLR.cc/2025/Conference", label: "ICLR 2025", paper_count: 0 },
    ]);
  });
});

describe("POST /venue-papers/index", () => {
  it("fetches, embeds and stores every configured venue", async () => {
    const { baseUrl } = await withVenue();
    const response = await fetch(`${baseUrl}/venue-papers/index`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      built: Array<{ venue_id: string; paper_count: number; embedding_model: string }>;
      failed: unknown[];
    };
    expect(body.failed).toEqual([]);
    expect(body.built[0]).toMatchObject({ paper_count: 2, embedding_model: "test-model" });

    const listed = await fetch(`${baseUrl}/venue-papers/sources`, { headers: headers() });
    const sources = (await listed.json()) as { sources: Array<{ paper_count: number }> };
    expect(sources.sources[0]?.paper_count).toBe(2);
  });

  // Independent conferences: one dead venue id must not block every other index from refreshing.
  it("reports a failed venue without abandoning the others", async () => {
    const { baseUrl, mock } = await startService({
      venuePapersReader: async (venueId) => {
        if (venueId === "bad") {
          throw new Error("OpenReview returned 404 for bad");
        }
        return [SAFETY];
      },
      embedder: EMBEDDER,
      embeddingModel: "test-model",
    });
    mock.service.updateSettings({
      venue_sources: [
        { id: "bad", label: "Broken" },
        { id: "good", label: "Good" },
      ],
    });

    const response = await fetch(`${baseUrl}/venue-papers/index`, {
      method: "POST",
      headers: headers(),
    });
    const body = (await response.json()) as {
      built: Array<{ venue_id: string }>;
      failed: Array<{ venue_id: string; reason: string }>;
    };
    expect(body.built.map((entry) => entry.venue_id)).toEqual(["good"]);
    expect(body.failed[0]).toMatchObject({ venue_id: "bad" });
    expect(body.failed[0]?.reason).toContain("404");
  });

  it("answers 503 naming the variables when OpenReview is not configured", async () => {
    const { baseUrl, mock } = await startService({ embedder: EMBEDDER, embeddingModel: "m" });
    mock.service.updateSettings({ venue_sources: [{ id: "v", label: "V" }] });
    const response = await fetch(`${baseUrl}/venue-papers/index`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).toContain("OPENREVIEW_USERNAME");
  });

  it("refuses an unauthenticated caller", async () => {
    const { baseUrl } = await withVenue();
    const response = await fetch(`${baseUrl}/venue-papers/index`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});

describe("POST /venue-papers/search", () => {
  async function indexed() {
    const { baseUrl } = await withVenue();
    await fetch(`${baseUrl}/venue-papers/index`, { method: "POST", headers: headers() });
    return baseUrl;
  }

  it("returns the papers that match, with the keywords that explain why", async () => {
    const baseUrl = await indexed();
    const response = await fetch(`${baseUrl}/venue-papers/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ venue_id: "ICLR.cc/2025/Conference", interests: "AI safety" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      searched: number;
      results: Array<{ paper: { id: string }; matched_keywords: string[]; relevance: number }>;
      nothing_relevant: boolean;
    };
    expect(body.searched).toBe(2);
    expect(body.results[0]?.paper.id).toBe("p-safe");
    expect(body.results[0]?.matched_keywords).toEqual(["AI safety"]);
    expect(body.results[0]?.relevance).toBeCloseTo(1);
    expect(body.nothing_relevant).toBe(false);
  });

  // The index is the thing that takes minutes; searching an unbuilt venue has to say so rather
  // than look like a conference with no relevant papers.
  it("distinguishes an unindexed conference from one with no matches", async () => {
    const { baseUrl } = await withVenue();
    const response = await fetch(`${baseUrl}/venue-papers/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ venue_id: "ICLR.cc/2025/Conference", interests: "AI safety" }),
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain("not been indexed");
  });

  // Without this a member could name any OpenReview id and read whatever was indexed under it.
  it("refuses a conference that is not on the configured list", async () => {
    const baseUrl = await indexed();
    const response = await fetch(`${baseUrl}/venue-papers/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ venue_id: "SomeoneElse/2025", interests: "AI safety" }),
    });
    expect(response.status).toBe(404);
  });

  it("asks for interests rather than searching with nothing", async () => {
    const baseUrl = await indexed();
    const response = await fetch(`${baseUrl}/venue-papers/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ venue_id: "ICLR.cc/2025/Conference", interests: "   " }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses an unauthenticated caller", async () => {
    const baseUrl = await indexed();
    const response = await fetch(`${baseUrl}/venue-papers/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venue_id: "ICLR.cc/2025/Conference", interests: "AI safety" }),
    });
    expect(response.status).toBe(401);
  });
});
