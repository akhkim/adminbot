import { createHash } from "node:crypto";
import { askGuidebook, defaultGuidebookAskConfig, type GuidebookAskConfig } from "./ask.js";
import type { GuidebookFetch } from "./local-client.js";

const unavailable = () => ({
  answered: false,
  answer: "",
  sources: [] as string[],
  reason:
    "The member guidebook is unavailable. Please use the resource links or ask a lab administrator.",
});

/** The digest binds operator audience review to the exact parsed corpus, not its path. */
export async function askMemberGuidebook(
  question: string,
  options: {
    env?: NodeJS.ProcessEnv;
    config?: GuidebookAskConfig;
    fetchImpl?: GuidebookFetch;
  } = {},
) {
  const env = options.env ?? process.env;
  const indexPath = env.ADMINBOT_MEMBER_GUIDEBOOK_INDEX?.trim();
  const approvedHash = env.ADMINBOT_MEMBER_GUIDEBOOK_SHA256?.trim();
  if (!indexPath || !approvedHash || !/^[a-f0-9]{64}$/u.test(approvedHash)) {
    return unavailable();
  }
  try {
    const result = await askGuidebook(
      { question, maxResults: 4 },
      {
        config: {
          ...defaultGuidebookAskConfig,
          ...(env.ADMINBOT_MEMBER_GUIDEBOOK_EMBEDDING_URL
            ? { embeddingBaseUrl: env.ADMINBOT_MEMBER_GUIDEBOOK_EMBEDDING_URL }
            : {}),
          ...(env.ADMINBOT_MEMBER_GUIDEBOOK_ANSWER_URL
            ? { answerBaseUrl: env.ADMINBOT_MEMBER_GUIDEBOOK_ANSWER_URL }
            : {}),
          ...options.config,
          indexPath,
        },
        env,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        signal: AbortSignal.timeout(30_000),
        allowIndex: (index) =>
          createHash("sha256").update(JSON.stringify(index)).digest("hex") === approvedHash,
      },
    );
    // Internal reasons include filesystem paths and model endpoints. Never project those.
    return result.answered
      ? { answered: true, answer: result.answer, sources: result.sources }
      : unavailable();
  } catch {
    return unavailable();
  }
}
