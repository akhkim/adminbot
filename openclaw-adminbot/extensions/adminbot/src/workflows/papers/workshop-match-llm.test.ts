import { describe, expect, it, vi } from "vitest";
import type { GuidebookFetch } from "../../guidebook/local-client.js";
import {
  buildWorkshopMatchPrompt,
  createLocalWorkshopMatcher,
  parseWorkshopMatchReply,
} from "./workshop-match-llm.js";
import type { WorkshopNudgePaper, WorkshopProfile } from "./workshop-nudges.js";

function profile(id: string): WorkshopProfile {
  return {
    workshop_id: id,
    name: `Workshop ${id}`,
    parent_conference_key: "neurips-2026",
    parent_conference: "NeurIPS 2026",
    conference_location: "Test City",
    topics: ["AI safety"],
    topic_evidence: `We invite work on ${id}.`,
    routes: [
      {
        deadline_id: `${id}-deadline`,
        label: "submission",
        submission_type: "direct",
        deadline_aoe: "2035-09-01 23:59:59",
        source_url: `https://example.test/${id}`,
      },
    ],
    archival_status: "non_archival",
    cross_submission_status: "allowed",
    cross_submission_evidence: "allowed",
    cross_submission_source_url: `https://example.test/${id}`,
    profile_extracted_at: "2035-01-01T00:00:00Z",
  };
}

function paper(id: string): WorkshopNudgePaper {
  return {
    paper_id: id,
    title: `Paper ${id}`,
    topic_summary: "AI safety",
    lab_author_names: ["Ada"],
    publication_sources: ["CV"],
  };
}

function reply(body: unknown): Awaited<ReturnType<GuidebookFetch>> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
  };
}

describe("workshop match prompt", () => {
  it("puts the call for papers and every offered paper id in front of the model", () => {
    const prompt = buildWorkshopMatchPrompt(profile("mint"), [paper("p-1"), paper("p-2")]);
    expect(prompt).toContain("Call for papers:");
    expect(prompt).toContain("We invite work on mint.");
    expect(prompt).toContain("paper_id: p-1");
    expect(prompt).toContain("paper_id: p-2");
    expect(prompt).toContain("Paper p-1");
  });
});

describe("workshop match reply", () => {
  it("reads a fenced object and scales relevance to a fraction", () => {
    const matches = parseWorkshopMatchReply(
      '```json\n{"matches":[{"paper_id":"p-1","relevance":80,"reason":"On scope."}]}\n```',
      "mint",
      [paper("p-1")],
    );
    expect(matches).toEqual([
      { workshop_id: "mint", paper_id: "p-1", relevance: 0.8, reason: "On scope." },
    ]);
  });

  it("drops a paper the request never offered rather than recommending it", () => {
    expect(
      parseWorkshopMatchReply(
        '{"matches":[{"paper_id":"invented","relevance":95,"reason":"x"}]}',
        "mint",
        [paper("p-1")],
      ),
    ).toEqual([]);
  });

  it("fails loudly on a reply that is not a matches object", () => {
    expect(() => parseWorkshopMatchReply("I could not decide.", "mint", [paper("p-1")])).toThrow(
      /did not return a JSON object/u,
    );
    expect(() => parseWorkshopMatchReply('{"ok":true}', "mint", [paper("p-1")])).toThrow(
      /no matches array/u,
    );
  });
});

describe("createLocalWorkshopMatcher", () => {
  it("batches papers per workshop, runs them concurrently, and returns a stable order", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (_input: string, init?: { body?: string }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const prompt = init?.body ?? "";
      const ids = [...prompt.matchAll(/paper_id: (p-\d+)/gu)].flatMap((entry) =>
        entry[1] ? [entry[1]] : [],
      );
      inFlight -= 1;
      return reply({
        matches: ids.map((id) => ({ paper_id: id, relevance: 90, reason: "fits" })),
      });
    }) as unknown as GuidebookFetch;

    const matcher = createLocalWorkshopMatcher({
      fetchImpl,
      papersPerRequest: 2,
      maxConcurrentRequests: 4,
      env: {} as NodeJS.ProcessEnv,
    });
    const papers = ["p-1", "p-2", "p-3", "p-4", "p-5"].map(paper);
    const matches = await matcher({ papers, workshops: [profile("beta"), profile("alpha")] });

    // Two workshops x three batches of at most two papers.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(peak).toBeGreaterThan(1);
    expect(matches).toHaveLength(10);
    expect(matches.slice(0, 5).map((entry) => entry.paper_id)).toEqual([
      "p-1",
      "p-2",
      "p-3",
      "p-4",
      "p-5",
    ]);
    expect(matches[0]?.workshop_id).toBe("alpha");
  });

  it("refuses a non-loopback endpoint rather than sending papers off the box", async () => {
    const matcher = createLocalWorkshopMatcher({
      fetchImpl: vi.fn() as unknown as GuidebookFetch,
      baseUrl: "https://api.example.com/v1",
      env: {} as NodeJS.ProcessEnv,
    });
    await expect(matcher({ papers: [paper("p-1")], workshops: [profile("mint")] })).rejects.toThrow(
      /loopback/u,
    );
  });
});

describe("what the matcher will and will not ask the model to do", () => {
  // The match is a cross-product, and it runs inside an HTTP request a browser is waiting on. On
  // the live roster it is 125 upcoming workshops against 153 papers -- thousands of model calls,
  // tens of minutes. The browser gave up long before the server did, and the page reported the
  // service as unreachable, which is what it looked like from there.

  it("asks about each paper once, however many authors it has", async () => {
    // workshopNudgeInputsFromAdminBot repeats a paper once per recipient, which is right for
    // addressing a nudge and wrong here: the model scores a paper against a workshop, so a
    // seven-author paper asked seven times is seven times the work for one answer.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      seen.push(String(init?.body ?? ""));
      return reply({ matches: [] });
    }) as unknown as GuidebookFetch;

    const match = createLocalWorkshopMatcher({ fetchImpl, papersPerRequest: 50 });
    await match({
      workshops: [profile("mint")],
      papers: [paper("p-1"), paper("p-1"), paper("p-1"), paper("p-2")],
    });

    expect(seen).toHaveLength(1);
    const body = seen[0] ?? "";
    expect(body.split("paper_id: p-1").length - 1).toBe(1);
    expect(body).toContain("paper_id: p-2");
  });

  it("abandons a model call that never answers", async () => {
    // One unanswered call used to hold the whole request open, with no timeout anywhere in the
    // path -- which is how a slow model server turned into "couldn't reach the AdminBot service".
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as GuidebookFetch;

    const match = createLocalWorkshopMatcher({
      fetchImpl,
      requestTimeoutMs: 20,
      totalBudgetMs: 5_000,
    });

    await expect(match({ workshops: [profile("mint")], papers: [paper("p-1")] })).rejects.toThrow();
  });

  it("runs every job, however many there are", async () => {
    // No ceiling on the pass as a whole any more. It no longer happens inside the request that
    // asks for it, so the only thing that matters is that it finishes -- a truncated match is a
    // handful of workshops out of a hundred, and rendering that as the answer would send somebody
    // to nudge the wrong people.
    const calls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls.push(1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return reply({ matches: [] });
    }) as unknown as GuidebookFetch;

    const match = createLocalWorkshopMatcher({
      fetchImpl,
      papersPerRequest: 1,
      maxConcurrentRequests: 4,
    });
    const workshops = Array.from({ length: 12 }, (_, index) => profile(`w-${index}`));
    await match({ workshops, papers: [paper("p-1"), paper("p-2")] });

    expect(calls).toHaveLength(24);
  });

  it("reports progress as it goes, so a caller can persist it", async () => {
    // A pass is thousands of calls; without this a page opened mid-pass can only say "running".
    const seen: Array<[number, number]> = [];
    const fetchImpl = vi.fn(async () => reply({ matches: [] })) as unknown as GuidebookFetch;
    const match = createLocalWorkshopMatcher({
      fetchImpl,
      papersPerRequest: 1,
      maxConcurrentRequests: 1,
    });

    await match({
      workshops: [profile("a"), profile("b")],
      papers: [paper("p-1")],
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("keeps going when one batch fails, and says nothing about it in the results", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        throw new Error("one bad batch");
      }
      return reply({ matches: [{ paper_id: "p-1", relevance: 90, reason: "On scope." }] });
    }) as unknown as GuidebookFetch;

    const match = createLocalWorkshopMatcher({
      fetchImpl,
      papersPerRequest: 1,
      maxConcurrentRequests: 1,
    });
    const matches = await match({
      workshops: [profile("a"), profile("b")],
      papers: [paper("p-1")],
    });

    // The surviving workshop still produced its recommendation.
    expect(matches.map((entry) => entry.workshop_id)).toEqual(["b"]);
  });

  it("raises the real cause when every call fails", async () => {
    // Not a bad batch -- the endpoint. The original error carries the reason, which for the
    // non-loopback refusal is a rule about where paper titles may go, not an outage.
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as GuidebookFetch;

    const match = createLocalWorkshopMatcher({ fetchImpl });
    await expect(match({ workshops: [profile("a")], papers: [paper("p-1")] })).rejects.toThrow(
      /ECONNREFUSED/u,
    );
  });
});
