import { describe, expect, it, vi } from "vitest";
import {
  createLinkedInDraftRunner,
  extractPaperFromPdf,
  generateLinkedInDraft,
  type SocialDraftFetch,
} from "./social-draft.js";

const env = { OPENROUTER_API_KEY: "sk-or-v1-test" } as NodeJS.ProcessEnv;

function completion(content: string, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: "OK",
    async text() {
      return JSON.stringify({ choices: [{ message: { content } }] });
    },
  };
}

function raw(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: "Bad Request",
    async text() {
      return JSON.stringify(body);
    },
  };
}

const paperJson = JSON.stringify({
  title: "Localizing LLM Failures",
  authors: ["Joeun Yook", "Zhijing Jin"],
  abstract: "We localize failures in sequential decision making.",
});

describe("PDF extraction", () => {
  it("tries the free text engine first and does not pay for the native one", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(init?.body ?? "{}"));
      return completion(paperJson);
    }) as unknown as SocialDraftFetch;

    const paper = await extractPaperFromPdf("YmFzZTY0", { env, fetchImpl });

    expect(paper).toEqual({
      title: "Localizing LLM Failures",
      authors: ["Joeun Yook", "Zhijing Jin"],
      abstract: "We localize failures in sequential decision making.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({
      temperature: 0,
      plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }],
    });
  });

  it("falls back to the native engine when the text layer yields nothing", async () => {
    const engines: string[] = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}");
      engines.push(body.plugins[0].pdf.engine);
      return engines.length === 1 ? completion("not json at all") : completion(paperJson);
    }) as unknown as SocialDraftFetch;

    await expect(extractPaperFromPdf("YmFzZTY0", { env, fetchImpl })).resolves.toMatchObject({
      title: "Localizing LLM Failures",
    });
    expect(engines).toEqual(["pdf-text", "native"]);
  });

  it("tolerates a fenced JSON reply", async () => {
    const fetchImpl = vi.fn(async () =>
      completion("```json\n" + paperJson + "\n```"),
    ) as unknown as SocialDraftFetch;
    await expect(extractPaperFromPdf("x", { env, fetchImpl })).resolves.toMatchObject({
      authors: ["Joeun Yook", "Zhijing Jin"],
    });
  });

  it("refuses a paper with no abstract rather than drafting from the title", async () => {
    // The abstract is the prompt's only permitted source of claims, so no abstract means
    // anything the model writes about the paper would be invention.
    const fetchImpl = vi.fn(async () =>
      completion(JSON.stringify({ title: "T", authors: [], abstract: "" })),
    ) as unknown as SocialDraftFetch;
    await expect(extractPaperFromPdf("x", { env, fetchImpl })).rejects.toThrow(
      /no title or no abstract/u,
    );
  });

  it("stops after one attempt when the key is missing, and names the file to fix", async () => {
    const fetchImpl = vi.fn() as unknown as SocialDraftFetch;
    await expect(extractPaperFromPdf("x", { env: {}, fetchImpl })).rejects.toThrow(
      /adminbot\.env/u,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("draft generation", () => {
  const input = {
    paper: {
      title: "Localizing LLM Failures",
      authors: ["Joeun Yook"],
      abstract: "We localize failures.",
      url: "https://arxiv.org/abs/2601.00001",
    },
    authorsVerified: [
      {
        paperName: "Joeun Yook",
        displayName: "Joeun Yook",
        matched: true,
        match: "exact" as const,
        member_id: "jy",
      },
    ],
  };

  it("sends the lab system prompt and returns the post with markdown stripped", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url, init) => {
      sent = JSON.parse(init?.body ?? "{}");
      return completion(
        `**Excited** to share our paper by Joeun Yook. ${"padding ".repeat(160)} #AISafety #LLM #NLP #ICML2026 #AIResearch`,
      );
    }) as unknown as SocialDraftFetch;

    const draft = await generateLinkedInDraft(input, { env, fetchImpl });

    expect(draft.text).toContain("Excited to share");
    expect(draft.text).not.toContain("**");
    expect(draft.issues).toEqual([]);
    expect(draft.model).toBe("openai/gpt-5");
    const messages = sent.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("Jinesis Lab");
    expect(sent.temperature).toBe(0.9);
  });

  it("honors an OPENROUTER_MODEL override", async () => {
    const fetchImpl = vi.fn(async () =>
      completion("post text"),
    ) as unknown as SocialDraftFetch;
    const draft = await generateLinkedInDraft(input, {
      env: { ...env, OPENROUTER_MODEL: "anthropic/claude-opus-4.5" },
      fetchImpl,
    });
    expect(draft.model).toBe("anthropic/claude-opus-4.5");
  });

  it("returns shape problems as advice, not as a thrown error", async () => {
    // A short post is still worth showing a human; throwing would discard work already paid for.
    const fetchImpl = vi.fn(async () =>
      completion("Too short, no hashtags."),
    ) as unknown as SocialDraftFetch;
    const draft = await generateLinkedInDraft(input, { env, fetchImpl });
    expect(draft.text).toBe("Too short, no hashtags.");
    expect(draft.issues.join(" ")).toContain("900 minimum");
  });

  it("treats an HTTP 200 carrying an error member as a failure", async () => {
    // OpenRouter reports upstream provider failures this way, so status alone is not enough.
    const fetchImpl = vi.fn(async () =>
      raw({ error: { message: "upstream provider is down" } }),
    ) as unknown as SocialDraftFetch;
    await expect(generateLinkedInDraft(input, { env, fetchImpl })).rejects.toThrow(
      /upstream provider is down/u,
    );
  });

  it("refuses to generate without a key instead of falling back to a stub", async () => {
    const fetchImpl = vi.fn() as unknown as SocialDraftFetch;
    await expect(generateLinkedInDraft(input, { env: {}, fetchImpl })).rejects.toThrow(
      /OPENROUTER_API_KEY is not set/u,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("reasoning models", () => {
  // Regression: gpt-5 spent 1,280 of a 1,500 max_tokens budget on reasoning and returned
  // truncated JSON. The call was billed in full and the draft failed, so both requests now
  // send a minimal-reasoning hint and carry headroom above the size of their actual output.
  it("asks for minimal reasoning and leaves headroom on extraction", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url, init) => {
      sent = JSON.parse(init?.body ?? "{}");
      return completion(paperJson);
    }) as unknown as SocialDraftFetch;

    await extractPaperFromPdf("x", { env, fetchImpl });

    expect(sent.reasoning).toEqual({ effort: "minimal" });
    expect(Number(sent.max_tokens)).toBeGreaterThanOrEqual(4000);
  });

  it("does the same on generation, where truncation would cut the post short", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url, init) => {
      sent = JSON.parse(init?.body ?? "{}");
      return completion("a post");
    }) as unknown as SocialDraftFetch;

    await generateLinkedInDraft(
      {
        paper: { title: "T", authors: [], abstract: "A" },
        authorsVerified: [],
      },
      { env, fetchImpl },
    );

    expect(sent.reasoning).toEqual({ effort: "minimal" });
    expect(Number(sent.max_tokens)).toBeGreaterThanOrEqual(3000);
  });
});
