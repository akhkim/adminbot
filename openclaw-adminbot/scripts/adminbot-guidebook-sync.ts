#!/usr/bin/env node
import { defaultGuidebookAskConfig } from "../extensions/adminbot/src/guidebook/ask.ts";
import { resolveGuidebookIndexPath } from "../extensions/adminbot/src/guidebook/store.ts";
// Rebuilds the local guidebook index from its Google Doc.
//
// Run it after the guidebook changes, or on a cron. Everything it writes is
// lab-sensitive, so the index lands owner-only under ~/.openclaw and never in the
// repo or the workspace.
//
//   node --import tsx scripts/adminbot-guidebook-sync.ts --doc <googleDocId> [--title "Lab Guidebook"]
import { syncGuidebook } from "../extensions/adminbot/src/guidebook/sync.ts";

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const documentId = readFlag(argv, "doc") ?? process.env.ADMINBOT_GUIDEBOOK_DOC_ID;
  if (!documentId) {
    console.error(
      "usage: adminbot-guidebook-sync.ts --doc <googleDocId> [--title <title>] [--index <path>]",
    );
    console.error("       (or set ADMINBOT_GUIDEBOOK_DOC_ID)");
    return 2;
  }
  const indexPath = resolveGuidebookIndexPath(readFlag(argv, "index"));
  const embeddingModel = process.env.ADMINBOT_GUIDEBOOK_EMBED_MODEL?.trim()
    ? process.env.ADMINBOT_GUIDEBOOK_EMBED_MODEL.trim()
    : defaultGuidebookAskConfig.embeddingModel;
  const embeddingBaseUrl = process.env.ADMINBOT_GUIDEBOOK_EMBED_URL?.trim()
    ? process.env.ADMINBOT_GUIDEBOOK_EMBED_URL.trim()
    : defaultGuidebookAskConfig.embeddingBaseUrl;

  console.error(`Exporting ${documentId} and embedding with ${embeddingModel}…`);
  const index = await syncGuidebook({
    documentId,
    ...(readFlag(argv, "title") ? { documentTitle: readFlag(argv, "title") as string } : {}),
    indexPath,
    embeddingBaseUrl,
    embeddingModel,
    ...(process.env[defaultGuidebookAskConfig.embeddingApiKeyEnv]
      ? { embeddingApiKey: process.env[defaultGuidebookAskConfig.embeddingApiKeyEnv] as string }
      : {}),
    onProgress: (done, total) => {
      if (done === total || done % 64 === 0) {
        console.error(`  embedded ${done}/${total} chunks`);
      }
    },
  });
  console.error(`Wrote ${index.chunks.length} chunks to ${indexPath} (mode 0600).`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
