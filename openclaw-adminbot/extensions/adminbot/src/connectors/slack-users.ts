import { isSlackDefaultAvatar } from "../workflows/members/slack-avatar.js";
/**
 * Reads the whole Slack workspace member list (`users.list`) for the roster sync.
 *
 * Read-only: needs `users:read`, plus `users:read.email` for the address the roster matches on.
 * Every page is read before anything is returned, so a failure part-way through throws rather than
 * handing the sync a truncated workspace that would look like people leaving.
 */
import type {
  SlackDirectoryReader,
  SlackDirectoryUser,
} from "../workflows/members/slack-roster-sync.js";
import { adminBotSlackBotToken } from "./slack-admin.js";

/** The fetch this reader needs: SlackAdminFetch plus response headers, for Retry-After. */
export type SlackUsersFetch = (
  input: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type SlackUsersReaderOptions = {
  fetchImpl?: SlackUsersFetch;
  sleep?: (ms: number) => Promise<void>;
  /** Rate-limit retries per page before giving up. */
  maxRetries?: number;
  pageSize?: number;
};

/** Slack's Tier 2 methods ask for about a minute at worst; cap a hostile or garbled header. */
const MAX_RETRY_AFTER_SECONDS = 120;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

type RawSlackUser = {
  is_invited_user?: boolean;
  id?: unknown;
  deleted?: unknown;
  is_bot?: unknown;
  is_app_user?: unknown;
  is_restricted?: unknown;
  is_ultra_restricted?: unknown;
  real_name?: unknown;
  tz?: unknown;
  profile?: {
    real_name?: unknown;
    display_name?: unknown;
    email?: unknown;
    title?: unknown;
    image_512?: unknown;
    image_192?: unknown;
    image_72?: unknown;
    /** False when the person never uploaded a photo and Slack serves its default silhouette. */
    is_custom_image?: unknown;
  };
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** One `users.list` member, reduced to what the roster sync reads. */
export function normalizeSlackUser(raw: RawSlackUser): SlackDirectoryUser {
  const id = text(raw.id);
  if (!id) {
    throw new Error("Slack returned a user without an ID");
  }
  const profile = raw.profile ?? {};
  const fields: Partial<SlackDirectoryUser> = {
    real_name: text(profile.real_name) ?? text(raw.real_name),
    display_name: text(profile.display_name),
    email: text(profile.email)?.toLowerCase(),
    title: text(profile.title),
    tz: text(raw.tz),
    // Slack's silhouette is not a photo: offering it would overwrite nothing useful at best and
    // put a placeholder on the slide and the map at worst. The URL check covers payloads that
    // omit the flag.
    image:
      profile.is_custom_image === false
        ? undefined
        : [text(profile.image_512), text(profile.image_192), text(profile.image_72)].find(
            (url) => url && !isSlackDefaultAvatar(url),
          ),
  };
  return {
    id,
    deleted: raw.deleted === true,
    is_bot: raw.is_bot === true,
    is_app_user: raw.is_app_user === true,
    is_restricted: raw.is_restricted === true,
    is_ultra_restricted: raw.is_ultra_restricted === true,
    ...(raw.is_invited_user === true ? { is_invited_user: true } : {}),
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  };
}

function retryAfterMs(header: string | null | undefined): number {
  const seconds = Number(header);
  const bounded =
    Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
      : DEFAULT_RETRY_AFTER_SECONDS;
  return bounded * 1000;
}

/** The explicit placeholder flag: a comma-separated list of Slack user IDs an admin has marked. */
export function slackPlaceholderUserIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env.ADMINBOT_SLACK_PLACEHOLDER_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function createSlackUserDirectoryReader(
  env: NodeJS.ProcessEnv = process.env,
  options: SlackUsersReaderOptions = {},
): SlackDirectoryReader {
  const fetchImpl: SlackUsersFetch =
    options.fetchImpl ??
    ((input, init) => globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 5;
  const pageSize = String(options.pageSize ?? 200);
  return async () => {
    const token = adminBotSlackBotToken(env);
    const users: SlackDirectoryUser[] = [];
    const seen = new Set<string>();
    let cursor = "";
    do {
      const params = new URLSearchParams({ limit: pageSize, ...(cursor ? { cursor } : {}) });
      let body: {
        ok?: boolean;
        error?: string;
        members?: unknown;
        response_metadata?: { next_cursor?: string };
      };
      let httpOk = false;
      let httpStatus = 0;
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetchImpl(`https://slack.com/api/users.list?${params}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const raw = await response.text();
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        // Slack signals rate limiting with HTTP 429 and a Retry-After header; some proxies pass a
        // 200 with `error: "ratelimited"` instead. Both wait the asked-for time and retry the same
        // page, so the cursor never advances past a page that was not read.
        if (response.status === 429 || body.error === "ratelimited") {
          if (attempt >= maxRetries) {
            throw new Error(`Slack users.list still rate limited after ${maxRetries} retries`);
          }
          await sleep(retryAfterMs(response.headers?.get("retry-after")));
          continue;
        }
        httpOk = response.ok;
        httpStatus = response.status;
        break;
      }
      if (!httpOk || body.ok !== true || !Array.isArray(body.members)) {
        throw new Error(`Slack users.list failed: ${body.error ?? httpStatus}`);
      }
      for (const member of body.members) {
        users.push(normalizeSlackUser(member as RawSlackUser));
      }
      cursor = body.response_metadata?.next_cursor?.trim() ?? "";
      if (cursor && seen.has(cursor)) {
        throw new Error("Slack repeated a pagination cursor");
      }
      seen.add(cursor);
    } while (cursor);
    return users;
  };
}
