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
    const seen: Array<[number, number, number]> = [];
    const fetchImpl = vi.fn(async () => reply({ matches: [] })) as unknown as GuidebookFetch;
    const match = createLocalWorkshopMatcher({
      fetchImpl,
      papersPerRequest: 1,
      maxConcurrentRequests: 1,
    });

    await match({
      workshops: [profile("a"), profile("b")],
      papers: [paper("p-1")],
      onProgress: (done, total, failed) => seen.push([done, total, failed]),
    });

    // The leading zero is the total becoming known: until the jobs are built the page can only say
    // "working out how many papers and workshops to compare", and it should stop saying that as
    // soon as there is a number rather than after the first model call comes back.
    expect(seen).toEqual([
      [0, 2, 0],
      [1, 2, 0],
      [2, 2, 0],
    ]);
  });

  it("retries a call that fails, so one blip does not silently drop a workshop", async () => {
    // The per-call timeout stops an unanswered request from holding a concurrency slot forever. It
    // does not get the answer. A tunnel that blips for a second would otherwise cost a whole
    // (workshop, batch) pair, and the page cannot tell a dropped pair from a workshop that matched
    // nothing.
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
      retryBackoffMs: 0,
    });
    const matches = await match({
      workshops: [profile("a"), profile("b")],
      papers: [paper("p-1")],
    });

    expect(matches.map((entry) => entry.workshop_id)).toEqual(["a", "b"]);
  });

  it("keeps going when one batch fails for good, and reports it as a failed call", async () => {
    const seen: Array<[number, number, number]> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      if (init?.body?.includes("Workshop a")) {
        throw new Error("one bad batch");
      }
      return reply({ matches: [{ paper_id: "p-1", relevance: 90, reason: "On scope." }] });
    }) as unknown as GuidebookFetch;

    const match = createLocalWorkshopMatcher({
      fetchImpl,
      papersPerRequest: 1,
      maxConcurrentRequests: 1,
      retryBackoffMs: 0,
    });
    const matches = await match({
      workshops: [profile("a"), profile("b")],
      papers: [paper("p-1")],
      onProgress: (done, total, failed) => seen.push([done, total, failed]),
    });

    // The surviving workshop still produced its recommendation.
    expect(matches.map((entry) => entry.workshop_id)).toEqual(["b"]);
    // And the failure counted toward `done`. A failed call that did not advance the count is how a
    // pass reaches 1671 of 2540 and stops: the total is fixed at the start, so a job that reports
    // nothing leaves a hole the count can never close, and the tab spins forever.
    expect(seen.at(-1)).toEqual([2, 2, 1]);
  });

  it("stops when the pass is cancelled, and says it was cancelled", async () => {
    // Waiting out the thirty-minute stall window is the right default for a pass nobody is
    // watching. An administrator standing in front of a pass they know is broken should not have
    // to restart the service to reclaim the model.
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      return reply({ matches: [] });
    }) as unknown as GuidebookFetch;

    const match = createLocalWorkshopMatcher({
      fetchImpl,
      papersPerRequest: 1,
      maxConcurrentRequests: 1,
      retryBackoffMs: 0,
    });
    await expect(
      match({
        workshops: [profile("a"), profile("b")],
        papers: [paper("p-1")],
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/u);
  });

  it("raises the real cause when every call fails", async () => {
    // Not a bad batch -- the endpoint. The original error carries the reason, which for the
    // non-loopback refusal is a rule about where paper titles may go, not an outage.
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as GuidebookFetch;

    const match = createLocalWorkshopMatcher({ fetchImpl, retryBackoffMs: 0 });
    await expect(match({ workshops: [profile("a")], papers: [paper("p-1")] })).rejects.toThrow(
      /ECONNREFUSED/u,
    );
  });
});

/**
 * What the request asks of the server, given what the server is.
 *
 * Aurora's vLLM runs a reasoning model with two sequence slots. A pass that let the model think
 * at length, six requests at a time, with no output ceiling and no schema, lost 24 of its first
 * 37 calls to timeouts and unparseable replies. These pin the settings that stop that.
 */
describe("keeping calls short enough to answer", () => {
  function requestBody(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const init = fetchImpl.mock.calls[0]?.[1] as { body?: string } | undefined;
    return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
  }

  it("turns thinking off, caps the output, and asks vLLM to enforce the reply shape", async () => {
    const fetchImpl = vi.fn(async () => reply({ matches: [] }));
    const match = createLocalWorkshopMatcher({ fetchImpl: fetchImpl as unknown as GuidebookFetch });
    await match({ workshops: [profile("a")], papers: [paper("p-1")] });

    const body = requestBody(fetchImpl);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0);
    const format = body.response_format as {
      type: string;
      json_schema: { strict: boolean; schema: { required: string[] } };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.required).toEqual(["matches"]);
  });

  it("runs two calls at a time unless the environment says the server admits more", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return reply({ matches: [] });
    }) as unknown as GuidebookFetch;
    const workshops = ["a", "b", "c", "d", "e", "f"].map((id) => profile(id));

    await createLocalWorkshopMatcher({ fetchImpl, env: {} })({ workshops, papers: [paper("p-1")] });
    expect(peak).toBe(2);

    peak = 0;
    await createLocalWorkshopMatcher({
      fetchImpl,
      env: { ADMINBOT_WORKSHOP_MATCH_CONCURRENCY: "4" },
    })({ workshops, papers: [paper("p-1")] });
    expect(peak).toBe(4);
  });

  it("says which workshop failed and why, alongside the count", async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      if (init?.body?.includes("Workshop a")) {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return reply({ matches: [] });
    }) as unknown as GuidebookFetch;

    await createLocalWorkshopMatcher({
      fetchImpl,
      maxConcurrentRequests: 1,
      retryBackoffMs: 0,
    })({
      workshops: [profile("a"), profile("b")],
      papers: [paper("p-1")],
      onProgress: (_done, _total, _failed, detail) => seen.push(detail),
    });

    // The first report is the total becoming known; the failure names its workshop and spells
    // the timeout out as what it was, and the detail stays on later reports so the last one --
    // the one that ends up on the run -- still carries it.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe("Workshop a: the model did not answer in time");
    expect(seen.at(-1)).toBe("Workshop a: the model did not answer in time");
  });
});
