/**
 * Rebuilds the guidebook index from its Google Doc.
 *
 * The export runs through the same `gog` CLI AdminBot already uses for Calendar
 * and Gmail, so it inherits that account's auth rather than introducing another
 * credential. Embedding happens locally and in batches; the doc text is held in
 * memory and written only into the owner-only index.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chunkGuidebookMarkdown } from "./chunk.js";
import { parseDocsJson, renderDocsDocumentAsMarkdown } from "./docs-json.js";
import { embedLocally, type GuidebookFetch } from "./local-client.js";
import { writeGuidebookIndex } from "./store.js";
import type { GuidebookChunk, GuidebookIndex } from "./types.js";

const execFileAsync = promisify(execFile);

/** How many chunks to embed per request. Keeps the local server responsive on a
 *  100+ page doc without paying per-chunk round-trip cost. */
const EMBED_BATCH = 16;

function resolveGogBinary(): string {
  // The systemd unit runs with a minimal PATH that misses the per-user install
  // dir, the same reason scripts/adminbot-drive-download.ts falls back this way.
  const userGog = path.join(os.homedir(), ".local", "bin", "gog");
  return process.env.GOG_BIN ?? (fs.existsSync(userGog) ? userGog : "gog");
}

export type GuidebookExecFile = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

/**
 * Reads the doc as markdown.
 *
 * Not `gog docs export`: that goes through Drive's `files.export`, which returns
 * 403 exportSizeLimitExceeded once the converted file passes 10 MB, and a
 * 100-page guidebook does. `gog docs cat --raw` calls `documents.get` instead,
 * which has no such cap and hands back the heading levels explicitly, so the
 * markdown is reconstructed here rather than parsed out of an exported file.
 */
export async function exportGuidebookMarkdown(params: {
  documentId: string;
  account?: string;
  execFileImpl?: GuidebookExecFile;
}): Promise<string> {
  // "auto" only resolves when the account has exactly one stored token, and when
  // it does not, gog's error reads as a flag problem rather than a missing env.
  const account = params.account ?? process.env.GOG_ACCOUNT?.trim();
  if (!account) {
    throw new Error(
      "GOG_ACCOUNT is not set. Source the AdminBot env file first: set -a; . ~/.config/jinesis-adminbot/adminbot.env; set +a",
    );
  }
  const run = params.execFileImpl ?? (execFileAsync as unknown as GuidebookExecFile);
  const { stdout } = await run(
    resolveGogBinary(),
    [
      "docs",
      "cat",
      params.documentId,
      "--raw",
      "--all-tabs",
      // 0 lifts gog's 2 MB read cap; the guidebook is the whole point here.
      "--max-bytes",
      "0",
      "--account",
      account,
      "--no-input",
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 256 * 1024 * 1024, env: process.env },
  );
  if (!stdout.trim()) {
    throw new Error(`gog returned an empty guidebook for ${params.documentId}`);
  }
  const markdown = renderDocsDocumentAsMarkdown(parseDocsJson(stdout));
  if (!markdown.trim()) {
    throw new Error(`guidebook ${params.documentId} rendered to no text; check the document`);
  }
  return markdown;
}

export async function buildGuidebookIndex(params: {
  documentId: string;
  documentTitle: string;
  markdown: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKey?: string;
  fetchImpl?: GuidebookFetch;
  onProgress?: (done: number, total: number) => void;
}): Promise<GuidebookIndex> {
  const fetchImpl = params.fetchImpl ?? (globalThis.fetch as unknown as GuidebookFetch);
  const drafts = chunkGuidebookMarkdown(params.markdown);
  if (drafts.length === 0) {
    throw new Error("guidebook export produced no chunks; check the document formatting");
  }

  const chunks: GuidebookChunk[] = [];
  for (let start = 0; start < drafts.length; start += EMBED_BATCH) {
    const batch = drafts.slice(start, start + EMBED_BATCH);
    const vectors = await embedLocally({
      fetchImpl,
      baseUrl: params.embeddingBaseUrl,
      model: params.embeddingModel,
      ...(params.embeddingApiKey ? { apiKey: params.embeddingApiKey } : {}),
      inputs: batch.map((draft) => draft.text),
    });
    for (const [offset, draft] of batch.entries()) {
      const vector = vectors[offset];
      if (!vector) {
        throw new Error(`guidebook embedding skipped chunk ${draft.id}`);
      }
      chunks.push({ ...draft, vector });
    }
    params.onProgress?.(Math.min(start + EMBED_BATCH, drafts.length), drafts.length);
  }

  return {
    version: 1,
    documentId: params.documentId,
    documentTitle: params.documentTitle,
    embeddingModel: params.embeddingModel,
    syncedAt: new Date().toISOString(),
    chunks,
  };
}

export async function syncGuidebook(params: {
  documentId: string;
  documentTitle?: string;
  indexPath: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKey?: string;
  account?: string;
  execFileImpl?: GuidebookExecFile;
  fetchImpl?: GuidebookFetch;
  onProgress?: (done: number, total: number) => void;
}): Promise<GuidebookIndex> {
  const markdown = await exportGuidebookMarkdown({
    documentId: params.documentId,
    ...(params.account ? { account: params.account } : {}),
    ...(params.execFileImpl ? { execFileImpl: params.execFileImpl } : {}),
  });
  const index = await buildGuidebookIndex({
    documentId: params.documentId,
    documentTitle: params.documentTitle ?? params.documentId,
    markdown,
    embeddingBaseUrl: params.embeddingBaseUrl,
    embeddingModel: params.embeddingModel,
    ...(params.embeddingApiKey ? { embeddingApiKey: params.embeddingApiKey } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
  });
  await writeGuidebookIndex(params.indexPath, index);
  return index;
}
