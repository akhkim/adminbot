import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect, vi } from "vitest";
import { defaultGuidebookAskConfig } from "./ask.js";
import { askMemberGuidebook } from "./member-ask.js";
import { writeGuidebookIndex } from "./store.js";
import type { GuidebookIndex } from "./types.js";

it("requires approval of exact content before any model call and hides internal errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "member-guidebook-"));
  try {
    const index: GuidebookIndex = {
      version: 1,
      documentId: "synthetic",
      documentTitle: "Synthetic member guide",
      embeddingModel: defaultGuidebookAskConfig.embeddingModel,
      syncedAt: "2026-09-07",
      chunks: [
        {
          id: "one",
          headings: ["Recordings"],
          label: "Recordings",
          text: "Open Meeting Recordings in Collaborate.",
          vector: [1, 0],
        },
      ],
    };
    const indexPath = path.join(dir, "index.json");
    await writeGuidebookIndex(indexPath, index);
    const fetcher = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify(
          url.endsWith("embeddings")
            ? { data: [{ embedding: [1, 0] }] }
            : { choices: [{ message: { content: "Open Meeting Recordings in Collaborate." } }] },
        ),
    }));
    const env = {
      ADMINBOT_MEMBER_GUIDEBOOK_INDEX: indexPath,
      ADMINBOT_MEMBER_GUIDEBOOK_SHA256: "0".repeat(64),
    };
    expect(
      (await askMemberGuidebook("Where are recordings?", { env, fetchImpl: fetcher })).answered,
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    env.ADMINBOT_MEMBER_GUIDEBOOK_SHA256 = createHash("sha256")
      .update(JSON.stringify(index))
      .digest("hex");
    const result = await askMemberGuidebook("Where are recordings?", { env, fetchImpl: fetcher });
    expect(result.answer).toContain("Meeting Recordings");
    expect(result.sources).toEqual(["Recordings"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error" }),
    );
    index.chunks[0].text = "New unreviewed sensitive content";
    await writeGuidebookIndex(indexPath, index);
    const changed = await askMemberGuidebook("Where?", { env, fetchImpl: fetcher });
    expect(changed.answered).toBe(false);
    expect(JSON.stringify(changed)).not.toContain(dir);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await askMemberGuidebook("Where?", { env: {}, fetchImpl: fetcher })).answered).toBe(
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
