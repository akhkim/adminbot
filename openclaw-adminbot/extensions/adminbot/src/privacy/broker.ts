import { randomUUID } from "node:crypto";
import type {
  AdminBotAuditEvent,
  AdminBotPrivacyTaskRequest,
  AdminBotPrivacyTaskResult,
} from "../contracts/actions.js";
import {
  errorCode,
  isInferenceDeferred,
  runGated,
  sharedInferenceGate,
  type InferenceFetch,
  type InferenceGate,
} from "../inference/gate.js";
import { currentTaskContext, taskStep } from "../tasks/context.js";

export type PrivacyBrokerFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export type AdminBotPrivacyBrokerConfig = {
  localBaseUrl: string;
  localModel: string;
  localApiKeyEnv: string;
  remoteBaseUrl: string;
  remoteModel: string;
  remoteApiKeyEnv: string;
};

export type AdminBotPrivacyBrokerOptions = {
  fetchImpl?: PrivacyBrokerFetch;
  env?: NodeJS.ProcessEnv;
  sensitiveTermsProvider?: () => string[] | Promise<string[]>;
  /** The admission gate for local calls. Tests hand in their own; production uses the shared one. */
  gate?: InferenceGate;
  /**
   * Where a fallback is recorded. Every route here can fall back to the local model when a stage
   * fails, and for a long time that happened silently: a remote outage looked like every task being
   * private. Each fallback now leaves an `inference.failed` row saying which stage failed and why.
   */
  recordAudit?: (event: Omit<AdminBotAuditEvent, "id" | "timestamp">) => void;
};

/**
 * Who the task is for and how it should meet a busy GPU. Optional and additive: the request
 * contract (`AdminBotPrivacyTaskRequest`) is what agents send and stays as it is; this is what the
 * HTTP layer knows from the session and the caller's headers.
 */
export type AdminBotPrivacyTaskContext = {
  owner?: string;
  wait?: boolean;
  submissionKey?: string;
};

export type AdminBotPrivacyBroker = {
  handle(
    request: AdminBotPrivacyTaskRequest,
    signal?: AbortSignal,
    context?: AdminBotPrivacyTaskContext,
  ): Promise<AdminBotPrivacyTaskResult>;
};

export const defaultAdminBotPrivacyBrokerConfig = {
  localBaseUrl: "http://127.0.0.1:8000/v1",
  localModel: "nvidia/Qwen3.5-122B-A10B-NVFP4",
  localApiKeyEnv: "VLLM_API_KEY",
  remoteBaseUrl: "https://integrate.api.nvidia.com/v1",
  remoteModel: "minimaxai/minimax-m3",
  remoteApiKeyEnv: "NVIDIA_API_KEY",
} satisfies AdminBotPrivacyBrokerConfig;

type PrivacyClassification = {
  classification: "generic" | "private" | "uncertain";
  sanitized_task: string;
  replacements: Array<{ placeholder: string; value: string }>;
};

const PLACEHOLDER_PATTERN = /^<<PRIVATE_[A-Z0-9_]+>>$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const OBVIOUS_SENSITIVE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b\d{3}-\d{2}-\d{4}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+/giu,
] as const;

export function createAdminBotPrivacyBroker(
  config: AdminBotPrivacyBrokerConfig = defaultAdminBotPrivacyBrokerConfig,
  options: AdminBotPrivacyBrokerOptions = {},
): AdminBotPrivacyBroker {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as PrivacyBrokerFetch);
  const env = options.env ?? process.env;
  return createPrivacyBrokerHandler(config, fetchImpl, env, options);
}

// Raw requests are classified locally before any remote model call.

/** Per-task state shared across classification, local execution, and finalization. */
type TaskRun = {
  config: AdminBotPrivacyBrokerConfig;
  fetchImpl: PrivacyBrokerFetch;
  env: NodeJS.ProcessEnv;
  gate: InferenceGate;
  context: AdminBotPrivacyTaskContext;
  audit: (stage: string, error: unknown, fallback: string) => void;
  /**
   * Set once the first local stage has been admitted. A later stage then waits for its slot rather
   * than being shed: the member is already holding the connection for an answer, and a task shed
   * halfway leaves them a classification they cannot use. The first stage is where "wait or try
   * later" is decided; after that the task finishes. The depth cap still applies -- a full line
   * sheds a later stage too, and the member gets that stage's handle.
   */
  admitted: boolean;
  /** Groups this task's stage rows when the caller sent no submission key. */
  taskId: string;
  signal?: AbortSignal;
};

function createPrivacyBrokerHandler(
  config: AdminBotPrivacyBrokerConfig,
  fetchImpl: PrivacyBrokerFetch,
  env: NodeJS.ProcessEnv,
  options: AdminBotPrivacyBrokerOptions,
): AdminBotPrivacyBroker {
  const sensitiveTermsProvider = options.sensitiveTermsProvider;
  return {
    async handle(request, signal, context = {}) {
      const task = request.task.trim();
      if (!task) {
        throw new Error("privacy task is required");
      }
      const run: TaskRun = {
        config,
        fetchImpl,
        env,
        // Resolved per call, not per broker: the server installs the durable gate after the broker
        // is built, and a broker that captured the placeholder would be a second counter.
        gate: options.gate ?? sharedInferenceGate(),
        context,
        admitted: false,
        taskId: `task:${randomUUID()}`,
        audit: (stage, error, fallback) => {
          options.recordAudit?.({
            type: "inference.failed",
            ...(context.owner ? { actor: context.owner } : {}),
            details: {
              caller: `privacy_broker.${stage}`,
              outcome: "error",
              // A code and a status, never the message: the remote's error body and the local
              // model's can both quote the task back, and "message only" does not sanitize that.
              ...auditableError(error),
              fallback,
            },
          });
        },
        ...(signal ? { signal } : {}),
      };
      const currentSensitiveTerms = (await sensitiveTermsProvider?.()) ?? [];
      const defaultSensitiveTerms = await taskStep(
        "privacy.policy",
        {},
        () => currentSensitiveTerms,
        { replaySafe: true },
      );
      if (
        JSON.stringify([...defaultSensitiveTerms].toSorted()) !==
        JSON.stringify([...currentSensitiveTerms].toSorted())
      ) {
        throw new Error(
          "Privacy policy changed while this task was pending; submit a new task under the current policy.",
        );
      }
      const combinedSensitiveTerms = [...defaultSensitiveTerms, ...(request.sensitive_terms ?? [])];
      let classification: PrivacyClassification;
      try {
        classification = await classifyLocally(run, task, {
          ...request,
          sensitive_terms: combinedSensitiveTerms,
        });
      } catch (error) {
        if (isInferenceDeferred(error) || isTaskInterruption(error)) {
          // The gate did not run the classifier: the GPU is busy and this member was shed, or is in
          // line. Falling back to a full local run here would be a second request to the same busy
          // GPU, so the decision goes up to the caller as it is.
          throw error;
        }
        // The classifier answered badly, or the local model is down. Both used to vanish here.
        run.audit("classify", error, "local");
        return runLocalOnly(run, task);
      }
      const required = findObviousSensitiveValues(task, combinedSensitiveTerms);
      if (
        request.privacy !== "private" &&
        required.length === 0 &&
        classification.classification === "generic"
      ) {
        const output = await runRemote(config, fetchImpl, env, task, signal).catch((error) => {
          if (isTaskInterruption(error)) {
            throw error;
          }
          run.audit("remote", error, "local");
          return undefined;
        });
        return output ? { route: "remote", output } : runLocalOnly(run, task);
      }
      return runPrivateTask(run, task, classification, required);
    },
  };
}

async function runPrivateTask(
  run: TaskRun,
  task: string,
  classification: PrivacyClassification,
  required: string[],
): Promise<AdminBotPrivacyTaskResult> {
  if (
    classification.classification === "private" &&
    isSafeSanitization(task, classification, required)
  ) {
    const draft = await runRemote(
      run.config,
      run.fetchImpl,
      run.env,
      classification.sanitized_task,
      run.signal,
    ).catch((error) => {
      if (isTaskInterruption(error)) {
        throw error;
      }
      run.audit("remote", error, "local");
      return undefined;
    });
    if (draft) {
      try {
        const output = await finalizeLocally(run, task, draft, classification.replacements);
        return { route: "hybrid", output };
      } catch (error) {
        if (isInferenceDeferred(error) || isTaskInterruption(error)) {
          // Same rule as the classifier: a queue decision is not a reason for another GPU call.
          throw error;
        }
        // The remote model saw placeholders only. Re-run the full task locally.
        run.audit("finalize", error, "local");
      }
    }
  }
  return runLocalOnly(run, task);
}

async function classifyLocally(
  run: TaskRun,
  task: string,
  request: AdminBotPrivacyTaskRequest,
): Promise<PrivacyClassification> {
  const prompt = {
    task,
    force_private: request.privacy === "private",
    explicitly_sensitive_terms: (request.sensitive_terms ?? []).filter((term) => term.trim()),
  };
  const content = await callLocalModel(
    run,
    "classify",
    [
      {
        role: "system",
        content:
          "Return JSON only with classification (generic, private, or uncertain), sanitized_task, and replacements. Replace every private value with a unique <<PRIVATE_1>> token and include exact placeholder/value pairs. Credentials, personal identifiers, private files, medical, legal, financial, employment data, and ambiguity are not generic. This privacy gate runs locally.",
      },
      { role: "user", content: JSON.stringify(prompt) },
    ],
    true,
  );
  return parseClassification(content);
}

async function runLocalOnly(run: TaskRun, task: string): Promise<AdminBotPrivacyTaskResult> {
  const output = await callLocalModel(
    run,
    "local",
    [
      {
        role: "system",
        content:
          "Handle this task entirely locally. Do not send private values to another service.",
      },
      { role: "user", content: task },
    ],
    false,
  );
  return { route: "local", output };
}

async function finalizeLocally(
  run: TaskRun,
  originalTask: string,
  remoteOutput: string,
  replacements: PrivacyClassification["replacements"],
): Promise<string> {
  return callLocalModel(
    run,
    "finalize",
    [
      {
        role: "system",
        content:
          "Fill only the placeholders needed by the answer. Do not reveal credentials or unrelated private values. Return only the final answer.",
      },
      {
        role: "user",
        content: JSON.stringify({
          original_task: originalTask,
          remote_draft: remoteOutput,
          replacements,
        }),
      },
    ],
    false,
  );
}

/** Acquire a separate permit per stage; no permit spans remote calls or subsequent local stages. */
async function callLocalModel(
  run: TaskRun,
  stage: "classify" | "local" | "finalize",
  messages: Array<{ role: "system" | "user"; content: string }>,
  json: boolean,
): Promise<string> {
  const { config, env } = run;
  const baseUrl = getValidatedLoopbackLocalBaseUrl(config.localBaseUrl);
  const apiKey = env[config.localApiKeyEnv]?.trim() || "vllm-local";
  const wait = run.context.wait ?? (run.admitted ? true : undefined);
  // Every stage of one task shares the task's identity, and `local`/`finalize` are the steps whose
  // completion means the task is done. A shed `classify` that is later waited on completes only the
  // classification; its stored status must say the task did not finish, not "Done".
  const task = run.context.submissionKey ?? run.taskId;
  const response = await runGated(run.gate, {
    owner: run.context.owner ?? "anonymous",
    caller: `privacy_broker.${stage}`,
    stage: { name: stage, task, final: stage !== "classify" },
    ...(wait !== undefined ? { wait } : {}),
    ...(run.context.submissionKey
      ? { submissionKey: `${run.context.submissionKey}:${stage}` }
      : {}),
    ...(run.signal ? { signal: run.signal } : {}),
    apiKey,
    fetchImpl: run.fetchImpl as unknown as InferenceFetch,
    request: {
      route: "chat/completions",
      baseUrl,
      purpose: "local privacy model",
      apiKeyEnv: config.localApiKeyEnv,
      body: {
        model: config.localModel,
        messages,
        temperature: 0,
        max_tokens: json ? 1024 : 4096,
        chat_template_kwargs: { enable_thinking: false },
        ...(json
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "privacy_classification",
                  strict: true,
                  schema: {
                    type: "object",
                    properties: {
                      classification: {
                        type: "string",
                        enum: ["generic", "private", "uncertain"],
                      },
                      sanitized_task: { type: "string" },
                      replacements: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            placeholder: { type: "string" },
                            value: { type: "string" },
                          },
                          required: ["placeholder", "value"],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ["classification", "sanitized_task", "replacements"],
                    additionalProperties: false,
                  },
                },
              },
            }
          : {}),
      },
    },
  });
  run.admitted = true;
  const parsed = parseJson(response.text, "local privacy model");
  if (!response.ok) {
    throw new Error(
      formatHttpError("local privacy model", response.status, response.statusText, parsed),
    );
  }
  const content = getNestedString(parsed, ["choices", "0", "message", "content"]);
  if (!content?.trim()) {
    throw new Error("local privacy model returned no content");
  }
  return content.trim();
}

function isTaskInterruption(error: unknown): boolean {
  return (
    Boolean(currentTaskContext()?.signal.aborted) ||
    (error instanceof Error &&
      ["TaskNeedsRetryError", "TaskInterruptedError", "TaskSuspendedError"].includes(error.name))
  );
}

async function runRemote(
  config: AdminBotPrivacyBrokerConfig,
  fetchImpl: PrivacyBrokerFetch,
  env: NodeJS.ProcessEnv,
  task: string,
  signal?: AbortSignal,
): Promise<string> {
  // No remote attempt occurred when credentials/configuration are absent; normal local fallback applies.
  if (!env[config.remoteApiKeyEnv]?.trim()) {
    throw new Error(`${config.remoteApiKeyEnv} is required for remote reasoning`);
  }
  if (new URL(config.remoteBaseUrl).protocol !== "https:") {
    throw new Error("remote reasoning URL must use https");
  }
  const key = "privacy.remote";
  const owner = currentTaskContext();
  const remoteSignal = owner
    ? AbortSignal.any([owner.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
    : signal;
  const result = await taskStep(
    key,
    { task, model: config.remoteModel, url: config.remoteBaseUrl },
    async () => {
      try {
        return {
          output: await runRemoteCall(config, fetchImpl, env, task, remoteSignal),
        };
      } catch (error) {
        if (error instanceof CompletedRemoteFailure) {
          return { error: error.message };
        }
        throw error;
      }
    },
    owner ? { timeoutMs: 120_000 } : undefined,
  );
  if (result.error) {
    throw new Error(result.error);
  }
  return result.output!;
}

class CompletedRemoteFailure extends Error {}

async function runRemoteCall(
  config: AdminBotPrivacyBrokerConfig,
  fetchImpl: PrivacyBrokerFetch,
  env: NodeJS.ProcessEnv,
  task: string,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = env[config.remoteApiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(`${config.remoteApiKeyEnv} is required for remote reasoning`);
  }
  const url = new URL("chat/completions", ensureTrailingSlash(config.remoteBaseUrl));
  if (url.protocol !== "https:") {
    throw new Error("remote reasoning URL must use https");
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.remoteModel,
      messages: [{ role: "user", content: task }],
      max_tokens: 4096,
    }),
    signal,
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = parseJson(raw, "remote reasoning model");
  } catch {
    throw new CompletedRemoteFailure("remote reasoning model returned malformed JSON");
  }
  if (!response.ok) {
    throw new CompletedRemoteFailure(
      `remote reasoning model error ${response.status}: ${response.statusText}`,
    );
  }
  const content = getNestedString(parsed, ["choices", "0", "message", "content"]);
  if (!content?.trim()) {
    throw new CompletedRemoteFailure("remote reasoning model returned no content");
  }
  return content.trim();
}

function parseClassification(content: string): PrivacyClassification {
  const parsed = parseJson(content, "privacy classifier");
  if (!parsed || typeof parsed !== "object") {
    throw new Error("privacy classifier returned an invalid object");
  }
  const value = parsed as Record<string, unknown>;
  if (!new Set(["generic", "private", "uncertain"]).has(String(value.classification))) {
    throw new Error("privacy classifier returned an invalid classification");
  }
  if (typeof value.sanitized_task !== "string") {
    throw new Error("privacy classifier returned an invalid sanitization");
  }
  const rawReplacements = Array.isArray(value.replacements)
    ? value.replacements
    : value.replacements && typeof value.replacements === "object"
      ? Object.entries(value.replacements).map(([placeholder, replacementValue]) => ({
          placeholder,
          value: replacementValue,
        }))
      : undefined;
  if (!rawReplacements) {
    throw new Error("privacy classifier returned invalid replacements");
  }
  const replacements = rawReplacements.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("privacy classifier returned an invalid replacement");
    }
    const replacement = entry as Record<string, unknown>;
    if (typeof replacement.placeholder !== "string" || typeof replacement.value !== "string") {
      throw new Error("privacy classifier returned an invalid replacement");
    }
    return { placeholder: replacement.placeholder, value: replacement.value };
  });
  return {
    classification: value.classification as PrivacyClassification["classification"],
    sanitized_task: value.sanitized_task,
    replacements,
  };
}

function isSafeSanitization(
  originalTask: string,
  classification: PrivacyClassification,
  requiredValues: string[],
): boolean {
  const sanitized = classification.sanitized_task;
  if (!sanitized.trim() || sanitized === originalTask || classification.replacements.length === 0) {
    return false;
  }
  const placeholders = new Set<string>();
  for (const replacement of classification.replacements) {
    if (
      !PLACEHOLDER_PATTERN.test(replacement.placeholder) ||
      !replacement.value ||
      placeholders.has(replacement.placeholder) ||
      !sanitized.includes(replacement.placeholder) ||
      sanitized.includes(replacement.value)
    ) {
      return false;
    }
    placeholders.add(replacement.placeholder);
  }
  return requiredValues.every(
    (value) =>
      !sanitized.includes(value) &&
      classification.replacements.some((replacement) => replacement.value === value),
  );
}

function findObviousSensitiveValues(task: string, explicitTerms: string[] = []): string[] {
  const lowerTask = task.toLowerCase();
  const values = new Set(
    explicitTerms
      .map((term) => term.trim())
      .filter((term) => term && lowerTask.includes(term.toLowerCase())),
  );
  for (const pattern of OBVIOUS_SENSITIVE_PATTERNS) {
    for (const match of task.matchAll(pattern)) {
      if (match[0]) {
        values.add(match[0]);
      }
    }
  }
  return [...values];
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

function getValidatedLoopbackLocalBaseUrl(value: string): string {
  const url = new URL(ensureTrailingSlash(value));
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("local privacy model must use a loopback URL");
  }
  return url.toString();
}

/**
 * What a failure may contribute to an audit row: an error class or code and, for HTTP failures, the
 * status. The message is excluded on purpose -- see the audit callback.
 */
function auditableError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { error_code: "unknown" };
  }
  const status = /\berror (\d{3})\b/u.exec(error.message)?.[1];
  return { error_code: errorCode(error), ...(status ? { http_status: Number(status) } : {}) };
}

function formatHttpError(
  source: string,
  status: number,
  statusText: string,
  parsed: unknown,
): string {
  const detail = getNestedString(parsed, ["error"]);
  return detail
    ? `${source} error ${status}: ${detail}`
    : `${source} error ${status}: ${statusText}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
