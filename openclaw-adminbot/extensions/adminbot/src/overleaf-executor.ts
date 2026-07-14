import type { AdminBotStoredProposal } from "./contracts.js";
import {
  assertOverleafPayloadReady,
  type AdminBotOverleafEditPayload,
} from "./overleaf-editing.js";
import type { AdminBotActionExecutor } from "./service-core.js";

export type OverleafFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export type AdminBotOverleafExecutorOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: OverleafFetch;
};

export function createAdminBotOverleafExecutor(
  options: AdminBotOverleafExecutorOptions = {},
): AdminBotActionExecutor {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as OverleafFetch);
  return {
    async execute(proposal) {
      if (proposal.type !== "paper.overleaf_edit") {
        return { handled: false };
      }
      const payload = readOverleafPayload(proposal);
      assertOverleafPayloadReady(payload);
      await applyOverleafEdit(payload, env, fetchImpl);
      return { handled: true };
    },
  };
}

function readOverleafPayload(proposal: AdminBotStoredProposal): AdminBotOverleafEditPayload {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("paper.overleaf_edit requires an object proposed_payload");
  }
  const overleafPayload = payload as AdminBotOverleafEditPayload;
  if (overleafPayload.action !== "apply_overleaf_project_edits") {
    throw new Error("unsupported paper.overleaf_edit payload action");
  }
  return overleafPayload;
}

async function applyOverleafEdit(
  payload: AdminBotOverleafEditPayload,
  env: NodeJS.ProcessEnv,
  fetchImpl: OverleafFetch,
): Promise<void> {
  const apiBaseUrl = env.OVERLEAF_API_BASE_URL?.trim();
  const token = env.OVERLEAF_ACCESS_TOKEN?.trim();
  if (!apiBaseUrl || !token) {
    throw new Error(
      "OVERLEAF_API_BASE_URL and OVERLEAF_ACCESS_TOKEN are required for approved Overleaf edits",
    );
  }
  const response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}/project-edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Overleaf edit failed ${response.status}: ${body.trim() || response.statusText}`,
    );
  }
}
