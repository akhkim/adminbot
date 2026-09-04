// Asking the model which of somebody else's spreadsheet columns is which of ours.
//
// Only the leftovers reach here. The Control UI settles a header called "Overleaf (edit)" and a
// column of `https://arxiv.org/abs/...` locally, instantly, and with the tunnel down (see
// ui/src/ui/adminbot/paper-import.ts). What is left is the genuinely ambiguous half -- "the latex
// one", "gdoc link", "pw" -- where the header is a person's shorthand and only the pairing of that
// shorthand with a few example values gives it away.
//
// Loopback-only, like every other model call in this tree: on this deployment that is the tunnel to
// Aurora's vLLM. What goes out is column headers and a few sample cells, which are lab-internal and
// do not leave the box.
//
// The answer is a suggestion. The UI merges it in without letting it overrule a column the header
// or the values had already settled, and every mapping is shown for review before anything is
// filled -- so the worst a wrong answer costs is one unticked row in a preview.

import { completeLocally, type GuidebookFetch } from "../../guidebook/local-client.js";

const PURPOSE = "paper import column mapping";
const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_MODEL = "nvidia/Qwen3.5-122B-A10B-NVFP4";

/** Sample values per column. Three is enough to show a shape and short enough to stay cheap. */
const SAMPLES_PER_COLUMN = 3;

/** Cell text is truncated before it is sent: a long abstract in a cell tells the model nothing. */
const SAMPLE_MAX_CHARS = 120;

export type ImportColumnQuestion = {
  /** The other sheet's header, verbatim -- it is the answer's key on the way back. */
  header: string;
  samples: string[];
};

export type ImportColumnMapper = (params: {
  unmapped: ImportColumnQuestion[];
  /** Column keys still free. The model may answer with one of these or with nothing. */
  available: string[];
  signal?: AbortSignal;
}) => Promise<Record<string, string>>;

function buildPrompt(params: { unmapped: ImportColumnQuestion[]; available: string[] }): string {
  const columns = params.unmapped
    .map((question) => {
      const samples = question.samples
        .slice(0, SAMPLES_PER_COLUMN)
        .map((value) => value.slice(0, SAMPLE_MAX_CHARS))
        .filter(Boolean);
      return `- ${JSON.stringify(question.header)} — examples: ${
        samples.length ? samples.map((value) => JSON.stringify(value)).join(", ") : "(all blank)"
      }`;
    })
    .join("\n");
  return [
    "A lab tracks its papers in a spreadsheet and is importing it into another tool.",
    "Match each of their columns to one of the target fields, using the header and the examples.",
    "",
    "Target fields still unclaimed:",
    params.available.map((key) => `- ${key}`).join("\n"),
    "",
    "Their columns:",
    columns,
    "",
    'Answer with JSON: {"mapping": {"<their header>": "<target field>"}}.',
    "Omit a column entirely when no target field is right. Do not invent a field name that is not",
    "on the list above, and do not use one field for two columns. A wrong guess costs more than a",
    "gap: an unmapped column is shown to the member, who can map it by hand.",
  ].join("\n");
}

/**
 * The mapper the API route uses.
 *
 * Fails soft on purpose. The local pass has already produced a usable mapping by the time this
 * runs, so a dead tunnel, a timeout or an unparseable reply should cost the leftovers and nothing
 * else -- an import that refused to proceed because the model was down would be a worse tool than
 * one with three columns left for the member to point at.
 */
export function createImportColumnMapper(options: {
  fetchImpl: GuidebookFetch;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): ImportColumnMapper {
  return async ({ unmapped, available, signal }) => {
    if (unmapped.length === 0 || available.length === 0) {
      return {};
    }
    let text: string;
    try {
      text = await completeLocally({
        fetchImpl: options.fetchImpl,
        baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
        model: options.model ?? DEFAULT_MODEL,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(signal ? { signal } : {}),
        purposeLabel: PURPOSE,
        temperature: 0,
        maxTokens: 600,
        messages: [
          {
            role: "system",
            content:
              "You map spreadsheet columns onto a fixed set of fields. You answer with JSON only.",
          },
          { role: "user", content: buildPrompt({ unmapped, available }) },
        ],
        extra: {
          chat_template_kwargs: { enable_thinking: false },
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "column_mapping",
              schema: {
                type: "object",
                properties: {
                  mapping: { type: "object", additionalProperties: { type: "string" } },
                },
                required: ["mapping"],
              },
            },
          },
        },
      });
    } catch {
      return {};
    }
    return readMapping(text, unmapped, available);
  };
}

/**
 * Reads the reply, keeping only what the caller asked about.
 *
 * Everything is checked rather than trusted: a header nobody asked about, a field that is not on
 * the list, a field used twice. The model is answering about the member's own spreadsheet and its
 * answer becomes a write, so the narrow gate here is what keeps a hallucinated field name from
 * turning into a column the UI then offers to fill.
 */
export function readMapping(
  text: string,
  unmapped: ImportColumnQuestion[],
  available: string[],
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text) ?? "");
  } catch {
    return {};
  }
  const mapping = (parsed as { mapping?: unknown } | null)?.mapping;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return {};
  }
  const asked = new Set(unmapped.map((question) => question.header));
  const free = new Set(available);
  const out: Record<string, string> = {};
  for (const [header, target] of Object.entries(mapping as Record<string, unknown>)) {
    if (typeof target !== "string" || !asked.has(header) || !free.has(target)) {
      continue;
    }
    // One field to one column, first answer wins, so a model that names `arxiv_url` twice does not
    // have its second answer silently beat its first.
    out[header] = target;
    free.delete(target);
  }
  return out;
}

/** Models fence JSON even when told not to. */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}
