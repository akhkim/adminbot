/**
 * The vendor leg of the LinkedIn draft: PDF extraction and generation, both via OpenRouter.
 *
 * Split from `workflows/papers/linkedin-draft.ts` on purpose. That file is pure -- prompt,
 * author verification, shape checks -- and this one is the only place the draft path opens a
 * socket. AGENTS.md: a workflow never touches a vendor.
 *
 * ── OPENROUTER_API_KEY: where it lives and why ──────────────────────────────────────────
 *
 * The key is read from `process.env` and from nowhere else. On Aurora that environment comes
 * from ONE file:
 *
 *     ~/.config/jinesis-adminbot/adminbot.env      (chmod 600, never committed)
 *
 * which systemd loads as `EnvironmentFile=` for jinesis-adminbot.service (see
 * deploy/aurora/install-user-services.sh). Add the key there and restart the unit:
 *
 *     OPENROUTER_API_KEY=sk-or-v1-...
 *     OPENROUTER_MODEL=openai/gpt-5                     # optional, this is the default
 *     systemctl --user restart jinesis-adminbot
 *
 * Three things this file deliberately does NOT do, each for a reason:
 *
 *   1. It does not read a workspace `.env`. It cannot: OPENROUTER_API_KEY is listed in
 *      BLOCKED_PROVIDER_AUTH_WORKSPACE_DOTENV_KEYS (src/infra/dotenv.ts), so a `.env` sitting
 *      in a checkout is ignored by design -- that is what stops a cloned repo from carrying a
 *      provider credential into the service.
 *   2. It does not read ~/.openclaw/.env. That is the standalone generator's convention
 *      (paper-post-lib.mjs) and it is a different trust boundary: that file is the operator's
 *      personal shell environment, this is a long-running service running as a user unit.
 *   3. It does not fall back to any other key, and it does not degrade to a templated post
 *      when the key is missing. It throws, naming the file to put the key in. A silent
 *      fallback would publish a stub in the lab's voice, which is worse than no draft.
 *
 * The paper's abstract and its author names DO leave Aurora on this path. That is a deliberate
 * choice for public-announcement copy about a paper that is about to be posted publicly; it is
 * not the route for anything the privacy broker would classify as private.
 */

import {
  buildLinkedInDraftPrompt,
  reviewLinkedInDraft,
  stripMarkdown,
  verifyAuthorsAgainstMembers,
  type AdminBotLinkedInDraftInput,
  type AdminBotPaperSource,
  type AdminBotVerifiedAuthor,
} from "../workflows/papers/linkedin-draft.js";
import type { AdminBotLabMember } from "../contracts/actions.js";

export type SocialDraftFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export type AdminBotSocialDraftOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: SocialDraftFetch;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Roughly half the per-paper cost of claude-sonnet-4.6 ($1.25/$10.00 per M against
// $3.00/$15.00) with the same file-input support, which the PDF extraction step needs.
// Extraction dominates the bill because the whole paper goes in as input tokens, so if cost
// matters more than prose quality, point OPENROUTER_MODEL at openai/gpt-5-mini or -nano.
const DEFAULT_MODEL = "openai/gpt-5";

/**
 * PDF engines, in cost order.
 *
 * `pdf-text` is free and reads the embedded text layer, which every LaTeX-produced paper has.
 * `native` hands the whole PDF to the model as input tokens (~$0.10-0.20 a paper) and is the
 * fallback for scanned or unusual PDFs. Trying the free one first is worth the extra round
 * trip because it succeeds on essentially every arXiv submission.
 */
const PDF_ENGINES = ["pdf-text", "native"] as const;

/**
 * Reasoning models spend the completion budget thinking before they write, and OpenRouter
 * counts that against `max_tokens`. Left at their default, gpt-5 burned 1,280 of 1,500 tokens
 * on reasoning and returned truncated JSON -- a silent failure that cost a full-price call.
 *
 * Neither of this file's two jobs benefits from it: extraction copies fields out of a PDF, and
 * the draft's structure is dictated by the system prompt. Non-reasoning models ignore the
 * field, so it is safe to send unconditionally.
 */
const NO_REASONING = { effort: "minimal" } as const;

function requireOpenRouterKey(env: NodeJS.ProcessEnv): string {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set, so no LinkedIn draft can be generated. Add it to " +
        "~/.config/jinesis-adminbot/adminbot.env (chmod 600) and restart jinesis-adminbot. " +
        "A workspace .env will not work: the key is blocked there on purpose.",
    );
  }
  return key;
}

function modelFor(env: NodeJS.ProcessEnv): string {
  return env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
}

async function callOpenRouter(
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  fetchImpl: SocialDraftFetch,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireOpenRouterKey(env)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  const record = (parsed ?? {}) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  // OpenRouter reports upstream provider failures as HTTP 200 with an `error` member, so the
  // status alone is not enough to tell success from failure.
  if (!response.ok || record.error) {
    const detail = record.error?.message ?? response.statusText;
    throw new Error(`${label} failed ${response.status}: ${detail}`);
  }
  const content = record.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`${label} returned an empty completion`);
  }
  return content.trim();
}

/**
 * Read title, ordered author list and abstract out of an uploaded paper PDF.
 *
 * `temperature: 0` because this is extraction, not writing: the same PDF must give the same
 * author list every time, or the roster cross-check becomes non-deterministic.
 */
export async function extractPaperFromPdf(
  pdfBase64: string,
  options: AdminBotSocialDraftOptions & { filename?: string; signal?: AbortSignal } = {},
): Promise<AdminBotPaperSource> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as SocialDraftFetch);
  const filename = options.filename ?? "paper.pdf";
  const errors: string[] = [];

  for (const engine of PDF_ENGINES) {
    try {
      const content = await callOpenRouter(
        {
          model: modelFor(env),
          // 4000 rather than the output's actual size: the ceiling has to cover any reasoning
          // the model emits first, and a truncated JSON reply fails after the call is billed.
          max_tokens: 4000,
          temperature: 0,
          reasoning: NO_REASONING,
          plugins: [{ id: "file-parser", pdf: { engine } }],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Extract from this research paper: the exact title, the full ordered author " +
                    'list, and the complete abstract. Reply with ONLY valid JSON, no code fences: ' +
                    '{"title": "...", "authors": ["First Last", ...], "abstract": "..."}',
                },
                {
                  type: "file",
                  file: { filename, file_data: `data:application/pdf;base64,${pdfBase64}` },
                },
              ],
            },
          ],
        },
        env,
        fetchImpl,
        `OpenRouter PDF extraction (${engine})`,
        options.signal,
      );
      return parseExtraction(content);
    } catch (error) {
      errors.push(`${engine}: ${(error as Error).message}`);
      // A missing key fails identically on every engine; retrying just burns time.
      if (/OPENROUTER_API_KEY/u.test((error as Error).message)) {
        break;
      }
    }
  }
  throw new Error(`could not extract paper metadata from the PDF (${errors.join("; ")})`);
}

function parseExtraction(content: string): AdminBotPaperSource {
  const unfenced = content
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error("PDF extraction did not return JSON");
  }
  const record = (parsed ?? {}) as { title?: unknown; authors?: unknown; abstract?: unknown };
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const abstract = typeof record.abstract === "string" ? record.abstract.trim() : "";
  const authors = Array.isArray(record.authors)
    ? record.authors.filter((a): a is string => typeof a === "string").map((a) => a.trim())
    : [];
  // The abstract is the prompt's only permitted source of claims, so a draft without one
  // would be pure invention. Refuse rather than generate from the title alone.
  if (!title || !abstract) {
    throw new Error("PDF extraction produced no title or no abstract");
  }
  return { title, authors, abstract };
}

export type AdminBotLinkedInDraft = {
  text: string;
  model: string;
  /** Advisory problems with the draft; a human sees these next to the text. */
  issues: string[];
  authors: AdminBotVerifiedAuthor[];
};

/**
 * Generate one Jinesis-voice LinkedIn post.
 *
 * `temperature: 0.9` is high on purpose and pairs with the randomized structure directives:
 * the grounding rules live in the system prompt, so the temperature buys variety of phrasing
 * rather than variety of facts.
 */
export async function generateLinkedInDraft(
  input: AdminBotLinkedInDraftInput,
  options: AdminBotSocialDraftOptions & { signal?: AbortSignal } = {},
): Promise<AdminBotLinkedInDraft> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as SocialDraftFetch);
  const model = modelFor(env);
  const { system, user } = buildLinkedInDraftPrompt(input);

  const content = await callOpenRouter(
    {
      model,
      max_tokens: 3000,
      temperature: 0.9,
      reasoning: NO_REASONING,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    env,
    fetchImpl,
    "OpenRouter LinkedIn draft",
    options.signal,
  );

  const text = stripMarkdown(content);
  return {
    text,
    model,
    issues: reviewLinkedInDraft(text, input.authorsVerified),
    authors: input.authorsVerified,
  };
}

/**
 * PDF in, finished post out, nothing persisted.
 *
 * The draft is a suggestion, not a record: the author copies it, edits it in LinkedIn's own
 * composer and posts it there. Storing it would leave a stale second copy of something whose
 * only authoritative version ends up on LinkedIn, so this returns and forgets.
 */
export type LinkedInDraftRequest = {
  pdfBase64: string;
  members: AdminBotLabMember[];
  filename?: string;
  url?: string;
  venue?: string;
  note?: string;
  signal?: AbortSignal;
};

export type LinkedInDraftResponse = {
  paper: { title: string; authors: string[]; abstract: string; url?: string };
  text: string;
  model: string;
  issues: string[];
  authors: AdminBotVerifiedAuthor[];
};

export type LinkedInDraftRunner = (
  request: LinkedInDraftRequest,
) => Promise<LinkedInDraftResponse>;

export function createLinkedInDraftRunner(
  options: AdminBotSocialDraftOptions = {},
): LinkedInDraftRunner {
  return async (request) => {
    const extracted = await extractPaperFromPdf(request.pdfBase64, {
      ...options,
      ...(request.filename ? { filename: request.filename } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    // The roster is the authority on spelling and on whether we can tag someone. An author it
    // does not know is reported, never dropped.
    const authorsVerified = verifyAuthorsAgainstMembers(extracted.authors, request.members);
    const paper = { ...extracted, ...(request.url ? { url: request.url } : {}) };
    const draft = await generateLinkedInDraft(
      {
        paper,
        authorsVerified,
        ...(request.venue ? { venue: request.venue } : {}),
        ...(request.note ? { note: request.note } : {}),
      },
      { ...options, ...(request.signal ? { signal: request.signal } : {}) },
    );
    return {
      paper,
      text: draft.text,
      model: draft.model,
      issues: draft.issues,
      authors: authorsVerified,
    };
  };
}
