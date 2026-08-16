import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { askGuidebook, defaultGuidebookAskConfig } from "./ask.js";
import { chunkGuidebookMarkdown } from "./chunk.js";
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

describe("guidebook export", () => {
  it("reads the file gog writes and clears the scratch directory", async () => {
    let scratchDir = "";
    const markdown = await exportGuidebookMarkdown({
      documentId: "doc-1",
      account: "lab@example.com",
      execFileImpl: async (_file, args) => {
        const target = args[args.indexOf("--out") + 1] ?? "";
        scratchDir = path.dirname(target);
        // gog writes the export itself; stand in for it.
        await writeFile(target, MARKDOWN, "utf8");
        return { stdout: "" };
      },
    });
    expect(markdown).toContain("per diem is $75");
    expect(existsSync(scratchDir)).toBe(false);
  });

  it("still clears the scratch directory when gog fails", async () => {
    let scratchDir = "";
    await expect(
      exportGuidebookMarkdown({
        documentId: "doc-1",
        execFileImpl: async (_file, args) => {
          scratchDir = path.dirname(args[args.indexOf("--out") + 1] ?? "");
          throw new Error("unknown flag");
        },
      }),
    ).rejects.toThrow(/unknown flag/u);
    expect(existsSync(scratchDir)).toBe(false);
  });
});
