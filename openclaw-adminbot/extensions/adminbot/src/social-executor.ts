import type { AdminBotStoredProposal } from "./contracts.js";
import type { AdminBotActionExecutor } from "./service-core.js";
import { assertSocialPayloadReady, type AdminBotPaperSocialPayload } from "./social-posting.js";

export type SocialFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export type AdminBotSocialExecutorOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: SocialFetch;
};

type XPostResult = { id?: string; text?: string };

export function createAdminBotSocialExecutor(
  options: AdminBotSocialExecutorOptions = {},
): AdminBotActionExecutor {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as SocialFetch);
  return {
    async execute(proposal) {
      if (proposal.type !== "social_media.post_publicly") {
        return { handled: false };
      }
      const payload = readSocialPayload(proposal);
      assertSocialPayloadReady(payload);
      if (payload.platforms.includes("linkedin")) {
        await postLinkedIn(payload, env, fetchImpl);
      }
      if (payload.platforms.includes("x")) {
        await postXThread(payload, env, fetchImpl);
      }
      return { handled: true };
    },
  };
}

function readSocialPayload(proposal: AdminBotStoredProposal): AdminBotPaperSocialPayload {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("social_media.post_publicly requires an object proposed_payload");
  }
  const socialPayload = payload as AdminBotPaperSocialPayload;
  if (socialPayload.action !== "publish_paper_social_posts") {
    throw new Error("unsupported social_media.post_publicly payload action");
  }
  return socialPayload;
}

async function postLinkedIn(
  payload: AdminBotPaperSocialPayload,
  env: NodeJS.ProcessEnv,
  fetchImpl: SocialFetch,
): Promise<void> {
  const accessToken = requireEnv(env, "LINKEDIN_ACCESS_TOKEN");
  const author = requireEnv(env, "LINKEDIN_AUTHOR_URN");
  const version = env.LINKEDIN_VERSION?.trim() || "202506";
  const text = payload.linkedin?.text.trim();
  if (!text) {
    throw new Error("linkedin post text is required");
  }
  const response = await fetchImpl("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": version,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author,
      commentary: text,
      visibility: payload.linkedin?.visibility ?? "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  await assertOk(response, "LinkedIn post");
}

async function postXThread(
  payload: AdminBotPaperSocialPayload,
  env: NodeJS.ProcessEnv,
  fetchImpl: SocialFetch,
): Promise<void> {
  const accessToken = requireEnv(env, "X_ACCESS_TOKEN");
  let replyToId: string | undefined;
  for (const post of payload.x?.posts ?? []) {
    const response = await fetchImpl("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: post,
        ...(replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : {}),
      }),
    });
    const body = await assertOk(response, "X post");
    replyToId = readTweetId(body);
  }
}

async function assertOk(
  response: { ok: boolean; status: number; statusText: string; text(): Promise<string> },
  label: string,
): Promise<unknown> {
  const raw = await response.text();
  const parsed = raw.trim() ? parseJson(raw, label) : undefined;
  if (!response.ok) {
    throw new Error(
      `${label} failed ${response.status}: ${formatErrorBody(parsed) || response.statusText}`,
    );
  }
  return parsed;
}

function readTweetId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const data = (body as { data?: XPostResult }).data;
  return typeof data?.id === "string" ? data.id : undefined;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function formatErrorBody(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") {
    return record.message;
  }
  if (typeof record.detail === "string") {
    return record.detail;
  }
  if (Array.isArray(record.errors)) {
    return record.errors
      .map((entry) => JSON.stringify(entry))
      .join("; ")
      .slice(0, 500);
  }
  return JSON.stringify(value).slice(0, 500);
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required for social posting`);
  }
  return value;
}
