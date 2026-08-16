import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { askGuidebook, defaultGuidebookAskConfig } from "./ask.js";
import { chunkGuidebookMarkdown } from "./chunk.js";
import { renderDocsDocumentAsMarkdown, parseDocsJson } from "./docs-json.js";
import { assertLoopbackUrl } from "./local-client.js";
import { rankGuidebookChunks } from "./retrieve.js";
import { writeGuidebookIndex } from "./store.js";
import { exportGuidebookMarkdown } from "./sync.js";
import type { GuidebookIndex } from "./types.js";

const MARKDOWN = [
  "# Reimbursements",
  "",
  "## Conference travel",
  "",
  "Submit receipts within 30 days of the trip. The per diem is $75.",
  "",
  "## Equipment",
  "",
  "Purchases over $500 need the PI's written approval before you order.",
].join("\n");

function unit(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / magnitude);
}

function indexFixture(): GuidebookIndex {
  return {
    version: 1,
    documentId: "doc-1",
    documentTitle: "Lab Guidebook",
    embeddingModel: defaultGuidebookAskConfig.embeddingModel,
    syncedAt: new Date().toISOString(),
    chunks: [
      {
        id: "travel-0",
        headings: ["Reimbursements", "Conference travel"],
        label: "Reimbursements > Conference travel",
        text: "Submit receipts within 30 days. The per diem is $75.",
        vector: unit([1, 0, 0]),
      },
      {
        id: "equipment-1",
        headings: ["Reimbursements", "Equipment"],
        label: "Reimbursements > Equipment",
        text: "Purchases over $500 need the PI's written approval.",
        vector: unit([0, 1, 0]),
      },
    ],
  };
}

describe("guidebook chunking", () => {
  it("keeps the heading trail with the text it explains", () => {
    const chunks = chunkGuidebookMarkdown(MARKDOWN);
    const travel = chunks.find((chunk) => chunk.label.includes("Conference travel"));
    expect(travel?.headings).toEqual(["Reimbursements", "Conference travel"]);
    expect(travel?.text).toContain("per diem is $75");
    expect(travel?.text).toContain("Reimbursements > Conference travel");
  });
});

describe("guidebook retrieval", () => {
  it("drops matches that are not close enough to answer from", () => {
    const hits = rankGuidebookChunks({
      chunks: indexFixture().chunks,
      queryVector: unit([0, 0, 1]),
    });
    expect(hits).toEqual([]);
  });

  it("ranks the closest section first", () => {
    const hits = rankGuidebookChunks({
      chunks: indexFixture().chunks,
      queryVector: unit([0.9, 0.1, 0]),
    });
    expect(hits[0]?.chunk.label).toBe("Reimbursements > Conference travel");
  });
});

describe("guidebook isolation", () => {
  it("refuses a non-loopback endpoint", () => {
    expect(() => assertLoopbackUrl("https://integrate.api.nvidia.com/v1", "answer")).toThrow(
      /loopback/u,
    );
    expect(() => assertLoopbackUrl("http://127.0.0.1:11434/v1", "answer")).not.toThrow();
  });

  it("returns prose and citations but never the guidebook text", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "guidebook-"));
    const indexPath = path.join(dir, "index.json");
    await writeGuidebookIndex(indexPath, indexFixture());

    const seen: string[] = [];
    const fetchImpl = async (input: string, init?: { body?: string }) => {
      seen.push(input);
      const body = init?.body ?? "";
      const payload = input.includes("embeddings")
        ? { data: [{ embedding: unit([1, 0, 0]) }] }
        : { choices: [{ message: { content: "Receipts are due within 30 days." } }] };
      // Excerpts may go to the local model, and only to the local model.
      if (input.includes("chat/completions")) {
        expect(body).toContain("per diem");
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(payload),
      };
    };

    const result = await askGuidebook(
      { question: "How long do I have to submit receipts?" },
      {
        config: { ...defaultGuidebookAskConfig, indexPath },
        fetchImpl,
        env: {},
      },
    );

    expect(result.answered).toBe(true);
    expect(result.answer).toBe("Receipts are due within 30 days.");
    expect(result.sources).toEqual(["Reimbursements > Conference travel"]);
    // The payload handed back to the agent carries no guidebook prose.
    expect(JSON.stringify(result)).not.toContain("per diem");
    // Embeddings on Ollama, synthesis on vLLM — both loopback, neither hosted.
    expect(
      seen.every(
        (url) =>
          url.startsWith("http://127.0.0.1:11434/") || url.startsWith("http://127.0.0.1:8000/"),
      ),
    ).toBe(true);
    expect(seen.some((url) => url.startsWith("http://127.0.0.1:8000/"))).toBe(true);
  });

  it("fails closed when the index was built by a different embedding model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "guidebook-"));
    const indexPath = path.join(dir, "index.json");
    await writeGuidebookIndex(indexPath, { ...indexFixture(), embeddingModel: "other-model" });

    const result = await askGuidebook(
      { question: "anything" },
      {
        config: { ...defaultGuidebookAskConfig, indexPath },
        fetchImpl: async () => {
          throw new Error("no model call should happen");
        },
        env: {},
      },
    );
    expect(result.answered).toBe(false);
    expect(result.reason).toMatch(/re-sync/u);
  });

  it("writes the index owner-only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "guidebook-"));
    const indexPath = path.join(dir, "index.json");
    await writeGuidebookIndex(indexPath, indexFixture());
    const stats = await stat(indexPath);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await readFile(indexPath, "utf8")).toContain("per diem");
  });
});

describe("guidebook account", () => {
  it("names the env file when GOG_ACCOUNT is missing", async () => {
    const previous = process.env.GOG_ACCOUNT;
    delete process.env.GOG_ACCOUNT;
    try {
      await expect(exportGuidebookMarkdown({ documentId: "doc-1" })).rejects.toThrow(
        /GOG_ACCOUNT is not set/u,
      );
    } finally {
      if (previous !== undefined) {
        process.env.GOG_ACCOUNT = previous;
      }
    }
  });
});

function headingParagraph(style: string, text: string) {
  return {
    paragraph: {
      paragraphStyle: { namedStyleType: style },
      elements: [{ textRun: { content: `${text}\n` } }],
    },
  };
}

function bodyParagraph(text: string, bullet?: boolean) {
  return {
    paragraph: {
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      elements: [{ textRun: { content: `${text}\n` } }],
      ...(bullet ? { bullet: { listId: "l1" } } : {}),
    },
  };
}

describe("docs json rendering", () => {
  it("turns named heading styles into markdown levels", () => {
    const markdown = renderDocsDocumentAsMarkdown({
      body: {
        content: [
          headingParagraph("HEADING_1", "Reimbursements"),
          headingParagraph("HEADING_2", "Conference travel"),
          bodyParagraph("Submit receipts within 30 days."),
          bodyParagraph("Keep the boarding pass.", true),
        ],
      },
    });
    expect(markdown).toContain("# Reimbursements");
    expect(markdown).toContain("## Conference travel");
    expect(markdown).toContain("- Keep the boarding pass.");
    // The chunker consumes this, so the pipeline has to survive the round trip.
    const chunks = chunkGuidebookMarkdown(markdown);
    expect(chunks.at(-1)?.label).toContain("Conference travel");
  });

  it("keeps table rows, which carry deadlines and amounts", () => {
    const markdown = renderDocsDocumentAsMarkdown({
      body: {
        content: [
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    { content: [bodyParagraph("Domestic")] },
                    { content: [bodyParagraph("$75/day")] },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    expect(markdown).toContain("Domestic | $75/day");
  });

  it("promotes tab titles so sections from different tabs do not collide", () => {
    const markdown = renderDocsDocumentAsMarkdown({
      tabs: [
        {
          tabProperties: { title: "Onboarding" },
          documentTab: { body: { content: [headingParagraph("HEADING_1", "Week one")] } },
          childTabs: [
            {
              tabProperties: { title: "Accounts" },
              documentTab: { body: { content: [bodyParagraph("Request a CS account.")] } },
            },
          ],
        },
      ],
    });
    expect(markdown).toContain("# Onboarding");
    expect(markdown).toContain("# Accounts");
    expect(markdown).toContain("Request a CS account.");
  });

  it("unwraps whichever envelope gog used", () => {
    const document = { body: { content: [headingParagraph("HEADING_1", "Policy")] } };
    for (const raw of [
      JSON.stringify(document),
      JSON.stringify({ result: document }),
      JSON.stringify({ document }),
    ]) {
      expect(renderDocsDocumentAsMarkdown(parseDocsJson(raw))).toContain("# Policy");
    }
    expect(() => parseDocsJson(JSON.stringify({ nope: true }))).toThrow(/without a Docs body/u);
  });
});

describe("guidebook read", () => {
  it("asks documents.get rather than the size-capped export endpoint", async () => {
    let captured: string[] = [];
    const markdown = await exportGuidebookMarkdown({
      documentId: "doc-1",
      account: "lab@example.com",
      execFileImpl: async (_file, args) => {
        captured = args;
        return {
          stdout: JSON.stringify({
            body: { content: [headingParagraph("HEADING_1", "Reimbursements")] },
          }),
        };
      },
    });
    expect(captured).toContain("cat");
    expect(captured).toContain("--raw");
    expect(captured).not.toContain("export");
    expect(captured.slice(captured.indexOf("--max-bytes"))).toContain("0");
    expect(markdown).toContain("# Reimbursements");
  });
});
