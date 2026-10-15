// Google Slides over plain REST, for the working-groups slide. No googleapis dependency: two
// endpoints and a service-account JWT are all it takes, and an injectable fetch is what lets every
// test run without reaching Google.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type {
  AdminBotSlidesWorkingGroupsPayload,
  GoogleSlidesClient,
  SlidesFaceRequest,
  SlidesPresentation,
  SlidesWorkingGroupsSource,
} from "../contracts/google-slides.js";
import type { AdminBotActionExecutor } from "../kernel/service.js";
import { flattenSlide } from "../workflows/slides/face-layout-measure.js";
import { POSITION_TOLERANCE_EMU } from "../workflows/slides/face-layout-plan.js";
import {
  DEFAULT_WORKING_GROUPS_SLIDE_TITLE,
  parseFaceObjectId,
} from "../workflows/slides/working-groups.js";

const SLIDES_API = "https://slides.googleapis.com/v1/presentations";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";
// Only what the measurement reads; the full presentation can run to megabytes of text styling.
const PRESENTATION_FIELDS = "presentationId,revisionId,pageSize,slides(objectId,pageElements)";

type Fetch = typeof fetch;
export type AccessTokenSource = () => Promise<string>;

async function googleError(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    // A non-JSON error page; the status alone is still the useful part.
  }
  return new Error(`Google Slides request failed (${response.status})${detail ? `: ${detail}` : ""}`);
}

export function createGoogleSlidesClient(options: {
  token: AccessTokenSource;
  fetch?: Fetch;
}): GoogleSlidesClient {
  const doFetch = options.fetch ?? fetch;
  const headers = async () => ({
    authorization: `Bearer ${await options.token()}`,
    "content-type": "application/json",
  });
  return {
    async getPresentation(presentationId) {
      const url = `${SLIDES_API}/${encodeURIComponent(presentationId)}?fields=${encodeURIComponent(PRESENTATION_FIELDS)}`;
      const response = await doFetch(url, { headers: await headers() });
      if (!response.ok) {
        throw await googleError(response);
      }
      return (await response.json()) as SlidesPresentation;
    },
    async batchUpdate(presentationId, requests) {
      const url = `${SLIDES_API}/${encodeURIComponent(presentationId)}:batchUpdate`;
      const response = await doFetch(url, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ requests }),
      });
      if (!response.ok) {
        throw await googleError(response);
      }
      return response.json();
    },
  };
}

export type ServiceAccountKey = { client_email: string; private_key: string; token_uri?: string };

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * An OAuth access token for a service account, cached until shortly before it expires.
 *
 * The deck is shared with the service account's address as an editor; nothing else in the lab's
 * Google estate is reachable with this scope, which is why it is a separate identity rather than
 * the account the Sheets export uses.
 */
export function serviceAccountTokenSource(options: {
  key: ServiceAccountKey;
  fetch?: Fetch;
  now?: () => number;
}): AccessTokenSource {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > now()) {
      return cached.token;
    }
    const issuedAt = Math.floor(now() / 1000);
    const tokenUri = options.key.token_uri ?? TOKEN_URI;
    const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
      JSON.stringify({
        iss: options.key.client_email,
        scope: SLIDES_SCOPE,
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    )}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(options.key.private_key);
    const response = await doFetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64Url(signature)}`,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Google token exchange failed (${response.status})`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new Error("Google token exchange returned no access token");
    }
    cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  };
}

/**
 * The token source the environment configures, or undefined when none is.
 *
 * A key file path rather than the key in an env var, so the secret lives in one file with tight
 * permissions instead of in every process listing that dumps the environment.
 */
export function googleSlidesTokenSourceFromEnv(
  env: NodeJS.ProcessEnv,
  options: { fetch?: Fetch; readFile?: (path: string) => string } = {},
): AccessTokenSource | undefined {
  const keyFile = env.ADMINBOT_SLIDES_SERVICE_ACCOUNT_FILE?.trim();
  if (keyFile) {
    const key = JSON.parse(
      (options.readFile ?? ((path) => readFileSync(path, "utf8")))(keyFile),
    ) as ServiceAccountKey;
    if (!key.client_email || !key.private_key) {
      throw new Error("ADMINBOT_SLIDES_SERVICE_ACCOUNT_FILE is not a service-account key");
    }
    return serviceAccountTokenSource({ key, ...(options.fetch ? { fetch: options.fetch } : {}) });
  }
  const token = env.ADMINBOT_SLIDES_ACCESS_TOKEN?.trim();
  return token ? async () => token : undefined;
}

function requirePayload(proposal: AdminBotStoredProposal): AdminBotSlidesWorkingGroupsPayload {
  const payload = proposal.proposed_payload as Partial<AdminBotSlidesWorkingGroupsPayload> | null;
  if (
    !payload ||
    typeof payload.presentation_id !== "string" ||
    typeof payload.slide_object_id !== "string" ||
    !Array.isArray(payload.requests) ||
    !Array.isArray(payload.expected)
  ) {
    throw new Error("slides.sync_working_groups requires presentation_id, slide_object_id, requests and expected");
  }
  return payload as AdminBotSlidesWorkingGroupsPayload;
}

function requestKind(request: SlidesFaceRequest): string {
  const keys = Object.keys(request);
  if (keys.length !== 1) {
    throw new Error("each Slides request must name exactly one operation");
  }
  return keys[0]!;
}

/**
 * Checks the payload only asks for what this action may do: create tagged faces on the planned
 * slide, and move or delete faces whose planned position it carries. Anything else -- a text
 * edit, a delete of an untagged id that was not planned, a create on another slide -- is refused
 * before Google is asked, whatever the approver signed.
 */
function validateRequests(payload: AdminBotSlidesWorkingGroupsPayload): void {
  const expected = new Set(payload.expected.map((entry) => entry.object_id));
  for (const request of payload.requests) {
    const kind = requestKind(request);
    if (kind === "createImage" && "createImage" in request) {
      const create = request.createImage;
      if (!parseFaceObjectId(create.objectId)) {
        throw new Error(`refusing to create ${create.objectId}: not an AdminBot face id`);
      }
      if (create.elementProperties.pageObjectId !== payload.slide_object_id) {
        throw new Error(`refusing to create ${create.objectId} on another slide`);
      }
      if (!/^https:\/\//u.test(create.url)) {
        throw new Error(`refusing to create ${create.objectId}: photo URL is not https`);
      }
    } else if (kind === "updatePageElementTransform" && "updatePageElementTransform" in request) {
      if (!expected.has(request.updatePageElementTransform.objectId)) {
        throw new Error(`refusing to move ${request.updatePageElementTransform.objectId}: not planned`);
      }
    } else if (kind === "deleteObject" && "deleteObject" in request) {
      if (!expected.has(request.deleteObject.objectId)) {
        throw new Error(`refusing to delete ${request.deleteObject.objectId}: not planned`);
      }
    } else {
      throw new Error(`refusing Slides request "${kind}": only createImage, updatePageElementTransform and deleteObject are allowed`);
    }
  }
}

/**
 * Whether the slide still looks the way it did when the plan was made.
 *
 * Per object rather than `requiredRevisionId`: the deck is edited by hand all week, and pinning
 * the revision would refuse every approval made after somebody fixed a typo on another slide. What
 * matters is that the faces being moved or deleted are still where the approver saw them.
 */
function staleReason(
  presentation: SlidesPresentation,
  payload: AdminBotSlidesWorkingGroupsPayload,
): string | null {
  const slide = presentation.slides?.find((page) => page.objectId === payload.slide_object_id);
  if (!slide) {
    return `slide ${payload.slide_object_id} no longer exists`;
  }
  const flat = new Map(flattenSlide(slide).map((entry) => [entry.element.objectId, entry]));
  for (const entry of payload.expected) {
    const current = flat.get(entry.object_id);
    if (!current?.element.image || current.grouped) {
      return `${entry.object_id} is no longer a loose image on the slide`;
    }
    if (
      Math.abs(current.rect.x - entry.translate_x) > POSITION_TOLERANCE_EMU ||
      Math.abs(current.rect.y - entry.translate_y) > POSITION_TOLERANCE_EMU
    ) {
      return `${entry.object_id} has been moved since the plan was made`;
    }
  }
  const allIds = new Set(
    (presentation.slides ?? []).flatMap((page) => flattenSlide(page).map((entry) => entry.element.objectId)),
  );
  for (const request of payload.requests) {
    if ("createImage" in request && allIds.has(request.createImage.objectId)) {
      return `${request.createImage.objectId} already exists`;
    }
  }
  return null;
}

export function createGoogleSlidesExecutor(options: {
  client: GoogleSlidesClient;
  // Kill switch, off by default like every connector that writes somewhere shared: a new
  // deployment shows its plans for a cycle before it can touch the deck. ADMINBOT_SLIDES_WRITE=1.
  write?: boolean;
}): AdminBotActionExecutor {
  return {
    async execute(proposal) {
      if (proposal.type !== "slides.sync_working_groups") {
        return { handled: false };
      }
      const payload = requirePayload(proposal);
      validateRequests(payload);
      if (!payload.requests.length) {
        return { handled: true };
      }
      if (!options.write) {
        return {
          handled: true,
          delivered: false,
          reason: "planned and validated, but not applied: ADMINBOT_SLIDES_WRITE is not set to 1",
        };
      }
      const current = await options.client.getPresentation(payload.presentation_id);
      const stale = staleReason(current, payload);
      if (stale) {
        return {
          handled: true,
          delivered: false,
          reason: `the slide changed since this was planned (${stale}); run the preview again`,
        };
      }
      await options.client.batchUpdate(payload.presentation_id, payload.requests);
      return {
        handled: true,
        artifacts: {
          presentation: `https://docs.google.com/presentation/d/${payload.presentation_id}/edit#slide=id.${payload.slide_object_id}`,
        },
      };
    },
  };
}

/**
 * The working-groups sync as the environment configures it, or undefined when no deck is named.
 *
 * Both halves come from one place so the read side (planning) and the write side (the executor)
 * can never point at different credentials. The source's face URL template, when set, has
 * `{url}` replaced by the URL-encoded photo address -- see docs/operations/slides-working-groups.md
 * for why that is opt-in.
 */
export function slidesWorkingGroupsFromEnv(
  env: NodeJS.ProcessEnv,
  options: { fetch?: Fetch; readFile?: (path: string) => string } = {},
): { source: SlidesWorkingGroupsSource; executor: AdminBotActionExecutor } | undefined {
  const presentationId = env.ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID?.trim();
  if (!presentationId) {
    return undefined;
  }
  const token = googleSlidesTokenSourceFromEnv(env, options);
  if (!token) {
    throw new Error(
      "ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID is set but neither ADMINBOT_SLIDES_SERVICE_ACCOUNT_FILE nor ADMINBOT_SLIDES_ACCESS_TOKEN is",
    );
  }
  const client = createGoogleSlidesClient({ token, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const template = env.ADMINBOT_SLIDES_FACE_URL_TEMPLATE?.trim();
  if (template && !template.includes("{url}")) {
    throw new Error("ADMINBOT_SLIDES_FACE_URL_TEMPLATE must contain {url}");
  }
  const debounce = Number(env.ADMINBOT_SLIDES_DEBOUNCE_MS);
  return {
    source: {
      presentationId,
      slideTitle: env.ADMINBOT_SLIDES_WORKING_GROUPS_SLIDE_TITLE?.trim() || DEFAULT_WORKING_GROUPS_SLIDE_TITLE,
      client,
      ...(template
        ? { faceImageUrl: (url: string) => template.replaceAll("{url}", encodeURIComponent(url)) }
        : {}),
      ...(Number.isFinite(debounce) && debounce > 0 ? { debounceMs: debounce } : {}),
    },
    executor: createGoogleSlidesExecutor({ client, write: env.ADMINBOT_SLIDES_WRITE === "1" }),
  };
}
