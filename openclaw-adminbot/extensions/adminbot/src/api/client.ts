import type {
  AdminBotActionProposal,
  AdminBotApprovalRequest,
  AdminBotExecutionRequest,
  AdminBotLabMemberInput,
  AdminBotPaperRecordInput,
  AdminBotPrivacyTaskRequest,
  AdminBotRemovePendingRequest,
  AdminBotSensitiveInfoRecord,
  AdminBotSettingsInput,
} from "../contracts/actions.js";
import type { AdminBotReimbursementRequest } from "../workflows/reimbursements/workflow.js";

export type AdminBotClientConfig = {
  serviceBaseUrl: string;
  serviceTokenEnv?: string;
  allowInsecureRemoteService: boolean;
  defaultDryRun: boolean;
};

export type FetchLike = (
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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * `ToolInputError` is the only error name the Gateway forwards verbatim to callers
 * (`resolveToolInputErrorStatus`); anything else becomes "tool execution failed". The Plugin SDK
 * does not export the class, so the name is reproduced here like other plugins do.
 */
class AdminBotServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class AdminBotClient {
  constructor(
    private readonly config: AdminBotClientConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async runEmailAutomation(signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", "/automation/email/run", {}, signal);
  }

  async converseReimbursement(
    request: AdminBotReimbursementRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("POST", "/reimbursements/converse", request, signal);
  }

  async generateReimbursement(
    draft: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("POST", "/reimbursements/generate", { draft }, signal);
  }

  async createProposal(proposal: AdminBotActionProposal, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      "POST",
      "/proposals",
      withDryRun(proposal, this.config.defaultDryRun),
      signal,
    );
  }

  async runPrivacyTask(
    request: AdminBotPrivacyTaskRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("POST", "/privacy/tasks", request, signal);
  }

  /** Asks the guidebook. The service answers locally; excerpts never come back. */
  async askGuidebook(
    request: { question: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("POST", "/guidebook/ask", request, signal);
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}`, undefined, signal);
  }

  async getTaskResult(taskId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}/result`, undefined, signal);
  }

  /** Call only after an explicit wait choice; submitting a task never selects Wait automatically. */
  async waitForTask(taskId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/wait`, {}, signal);
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/cancel`, {}, signal);
  }

  async retryTask(taskId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/retry`, {}, signal);
  }

  async listPending(limit?: number, signal?: AbortSignal): Promise<unknown> {
    const params = typeof limit === "number" ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return this.request("GET", `/proposals/pending${params}`, undefined, signal);
  }

  async removePending(
    actionId: string,
    request: AdminBotRemovePendingRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      "POST",
      "/proposals/" + encodeURIComponent(actionId) + "/remove",
      request,
      signal,
    );
  }

  async upsertLabMember(member: AdminBotLabMemberInput, signal?: AbortSignal): Promise<unknown> {
    return this.request("PUT", `/lab/members/${encodeURIComponent(member.id)}`, member, signal);
  }

  async listLabMembers(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/lab/members", undefined, signal);
  }

  async getSettings(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/settings", undefined, signal);
  }

  async updateSettings(settings: AdminBotSettingsInput, signal?: AbortSignal): Promise<unknown> {
    return this.request("PUT", "/settings", settings, signal);
  }

  async getSensitiveInfo(signal?: AbortSignal): Promise<AdminBotSensitiveInfoRecord> {
    return this.request(
      "GET",
      "/sensitive-info",
      undefined,
      signal,
    ) as Promise<AdminBotSensitiveInfoRecord>;
  }

  async updateSensitiveInfo(
    markdown: string,
    signal?: AbortSignal,
  ): Promise<AdminBotSensitiveInfoRecord> {
    return this.request(
      "PUT",
      "/sensitive-info",
      { markdown },
      signal,
    ) as Promise<AdminBotSensitiveInfoRecord>;
  }

  async upsertPaper(paper: AdminBotPaperRecordInput, signal?: AbortSignal): Promise<unknown> {
    return this.request("PUT", `/papers/${encodeURIComponent(paper.id)}`, paper, signal);
  }

  async deletePaper(paperId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("DELETE", `/papers/${encodeURIComponent(paperId)}`, undefined, signal);
  }

  async listPapers(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/papers", undefined, signal);
  }

  async listPaperNudges(nowIso?: string, signal?: AbortSignal): Promise<unknown> {
    const params = nowIso ? `?now=${encodeURIComponent(nowIso)}` : "";
    return this.request("GET", `/papers/nudges${params}`, undefined, signal);
  }

  async listOpenReviewStatus(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/openreview/status", undefined, signal);
  }

  async runOpenReviewCycle(send: boolean, signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", "/openreview/cycle/run", { send }, signal);
  }

  async suggestOpenReviewReviewers(venueId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      "GET",
      `/openreview/suggest-reviewers?venue=${encodeURIComponent(venueId)}`,
      undefined,
      signal,
    );
  }

  async approve(
    actionId: string,
    request: AdminBotApprovalRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/approvals/${encodeURIComponent(actionId)}/approve`,
      request,
      signal,
    );
  }

  async execute(
    actionId: string,
    request: AdminBotExecutionRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/actions/${encodeURIComponent(actionId)}/execute`,
      { ...request, dry_run: this.config.defaultDryRun },
      signal,
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = this.resolveUrl(path);
    const token = this.resolveToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    // The Gateway replaces any non-ToolInputError with an opaque "tool execution failed",
    // so every AdminBot service failure must carry its reason through this error shape or
    // the dashboard loses the only diagnosis the operator can act on.
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (error) {
      throw new AdminBotServiceError(
        `AdminBot service at ${this.config.serviceBaseUrl} is unreachable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const raw = await response.text();
    const parsed = raw.trim() ? parseJson(raw) : undefined;
    // Deferred application tasks are useful tool results. Throwing only their message would
    // discard the saved task identity, while interpreting HTTP 202 as an answer invents success.
    if (
      (["/privacy/tasks", "/guidebook/ask", "/reimbursements/converse"].includes(path) ||
        path.startsWith("/tasks/")) &&
      [200, 202, 409, 410, 502].includes(response.status)
    ) {
      const taskResult = describeTaskResponse(parsed);
      if (taskResult) {
        return taskResult;
      }
    }
    if (!response.ok) {
      throw new AdminBotServiceError(formatHttpError(response.status, response.statusText, parsed));
    }
    return parsed;
  }

  private resolveUrl(path: string): string {
    const url = new URL(path, ensureTrailingSlash(this.config.serviceBaseUrl));
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new AdminBotServiceError("AdminBot service URL must use http or https");
    }
    if (!this.config.allowInsecureRemoteService && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new AdminBotServiceError(
        "AdminBot service URL must be loopback unless allowInsecureRemoteService is enabled",
      );
    }
    return url.toString();
  }

  private resolveToken(): string | undefined {
    const envName = this.config.serviceTokenEnv?.trim();
    if (!envName) {
      return undefined;
    }
    const token = this.env[envName]?.trim();
    return token || undefined;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function withDryRun<T extends Record<string, unknown>>(body: T, defaultDryRun: boolean): T {
  if (Object.hasOwn(body, "dry_run")) {
    return body;
  }
  return { ...body, dry_run: defaultDryRun };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AdminBotServiceError("AdminBot service returned invalid JSON");
  }
}

function formatHttpError(status: number, statusText: string, parsed: unknown): string {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === "string") {
      return `AdminBot service error ${status}: ${error}`;
    }
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return `AdminBot service error ${status}: ${message}`;
      }
    }
  }
  return `AdminBot service error ${status}: ${statusText}`;
}

function describeTaskResponse(parsed: unknown): Record<string, unknown> | undefined {
  if (!parsed || typeof parsed !== "object" || !("task" in parsed)) {
    return;
  }
  const task = parsed.task;
  if (
    !task ||
    typeof task !== "object" ||
    !("id" in task) ||
    typeof task.id !== "string" ||
    !("status" in task) ||
    typeof task.status !== "string"
  ) {
    return;
  }
  const taskPath = `/tasks/${encodeURIComponent(task.id)}`;
  const knownActions = new Set(["wait", "cancel", "retry", "result"]);
  const actions =
    "actions" in task && Array.isArray(task.actions)
      ? task.actions.filter(
          (action): action is string => typeof action === "string" && knownActions.has(action),
        )
      : [];
  const messages: Record<string, string> = {
    shed: "The task is saved but has not run. Ask the user whether to wait; do not resubmit the original input or claim an answer is ready.",
    queued:
      "The task is accepted and queued. Check its status, then retrieve the completed application result.",
    running:
      "The task is running. Check its status, then retrieve the completed application result.",
    completed:
      "The task completed. Retrieve its application result from the result endpoint before answering.",
    needs_retry:
      "A step was interrupted or is uncertain. Ask for an explicit retry decision; do not repeat the original operation automatically.",
    failed:
      "The application task failed. Its status contains the failure; no completed answer is available.",
    cancelled: "The task was cancelled. No completed answer is available.",
    expired:
      "The saved task expired. A new submission is required if the user still wants the work.",
  };
  if (!messages[task.status]) {
    return;
  }
  return {
    ...parsed,
    outcome: "task_status",
    user_message: messages[task.status],
    supported_actions: [
      {
        action: "status",
        method: "GET",
        path: taskPath,
        tool: "adminbot_task",
        arguments: { taskId: task.id, action: "status" },
      },
      ...actions.map((action) => ({
        action,
        method: action === "result" ? "GET" : "POST",
        path: `${taskPath}/${action}`,
        tool: "adminbot_task",
        arguments: { taskId: task.id, action },
      })),
    ],
  };
}
