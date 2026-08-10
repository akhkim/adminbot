// Executes reviewing-cycle reminders by posting them through OpenReview's own message
// invitation. Routing sends through the normal propose -> approve -> execute path (rather
// than mailing from the workflow directly) is what makes the approval-gated overdue
// warnings work: a human clicks approve in Pending actions and the existing execute
// machinery delivers, exactly like every other outbound action type.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotActionExecutor } from "../kernel/service.js";

const execFile = promisify(execFileCallback);
const OPENREVIEW_TIMEOUT_MS = 120_000;
const OPENREVIEW_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type AdminBotOpenReviewExecutorOptions = {
  scriptPath: string;
  pythonCommand?: string;
  env?: NodeJS.ProcessEnv;
  // Global kill switch. Off by default so a freshly deployed service observes a full
  // cycle before it can mail a committee; flipped on with ADMINBOT_OPENREVIEW_SEND=1.
  send?: boolean;
  run?: (args: string[], body: string) => Promise<unknown>;
};

export function createAdminBotOpenReviewExecutor(
  options: AdminBotOpenReviewExecutorOptions,
): AdminBotActionExecutor {
  const run = options.run ?? createOpenReviewRunner(options);
  return {
    async execute(proposal) {
      if (proposal.type !== "openreview.nudge" && proposal.type !== "openreview.warning") {
        return { handled: false };
      }
      const payload = requirePayload(proposal);
      const args = [
        options.scriptPath,
        "message",
        "--invitation",
        requireString(payload, "invitation"),
        "--signature",
        requireString(payload, "signature"),
        "--groups",
        requireStringArray(payload, "groups").join(","),
        "--subject",
        requireString(payload, "subject"),
        "--body-file",
        "-",
      ];
      if (options.send) {
        args.push("--send");
      }
      await run(args, requireString(payload, "body"));
      return { handled: true };
    },
  };
}

function createOpenReviewRunner(
  options: AdminBotOpenReviewExecutorOptions,
): (args: string[], body: string) => Promise<unknown> {
  const python = options.pythonCommand ?? "python3";
  return async (args, body) => {
    const child = execFile(python, args, {
      env: options.env ?? process.env,
      maxBuffer: OPENREVIEW_MAX_OUTPUT_BYTES,
      timeout: OPENREVIEW_TIMEOUT_MS,
      windowsHide: true,
    });
    // The message body goes over stdin, never argv: bodies are multi-line and would
    // otherwise show up in the process table on a shared host.
    child.child.stdin?.end(body);
    const { stdout } = await child;
    const result = parseResult(stdout);
    if (result.ok === false) {
      throw new Error(
        `openreview message failed (${asText(result.reason) || "unknown"}): ${asText(result.error)}`,
      );
    }
    return result;
  };
}

// Bridge output is untyped JSON: a field that should be a message can be an object,
// which would otherwise land in the error as "[object Object]".
function asText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseResult(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`openreview bridge returned no JSON result: ${line.slice(0, 300)}`);
  }
}

function requirePayload(proposal: AdminBotStoredProposal): Record<string, unknown> {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${proposal.type} requires an object proposed_payload`);
  }
  return payload as Record<string, unknown>;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`proposed_payload.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`proposed_payload.${key} must be a non-empty array`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`proposed_payload.${key} entries must be non-empty strings`);
    }
    return entry.trim();
  });
}
