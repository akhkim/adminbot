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
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chunkGuidebookMarkdown } from "./chunk.js";
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
 * Exports the doc as markdown.
 *
 * `gog docs export` only writes to a file — there is no stdout mode, and
 * `gog docs cat` would hand back plain text with the heading structure stripped,
 * which is exactly what the chunker needs. So the export lands in an owner-only
 * temp directory that is removed before this returns, whether or not it threw.
 */
export async function exportGuidebookMarkdown(params: {
  documentId: string;
  account?: string;
  execFileImpl?: GuidebookExecFile;
}): Promise<string> {
  const account = params.account ?? process.env.GOG_ACCOUNT ?? "auto";
  const run = params.execFileImpl ?? (execFileAsync as unknown as GuidebookExecFile);
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "adminbot-guidebook-"));
  await fsp.chmod(scratch, 0o700);
  const target = path.join(scratch, "guidebook.md");
  try {
    await run(
      resolveGogBinary(),
      [
        "docs",
        "export",
        params.documentId,
        "--format",
        "md",
        "--out",
        target,
        "--overwrite",
        "--account",
        account,
        "--no-input",
      ],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: process.env },
    );
    // --out is documented as a file path, but the sibling `drive download` treats
    // it as a directory. Accept either rather than depending on which one this
    // gog build means.
    const written = fs.existsSync(target)
      ? target
      : (await fsp.readdir(scratch)).map((name) => path.join(scratch, name)).at(0);
    if (!written) {
      throw new Error(`gog wrote no export for ${params.documentId}`);
    }
    const markdown = await fsp.readFile(written, "utf8");
    if (!markdown.trim()) {
      throw new Error(`gog exported an empty guidebook for ${params.documentId}`);
    }
    return markdown;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
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
