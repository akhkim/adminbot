import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotActionExecutor } from "../kernel/service.js";

const execFile = promisify(execFileCallback);
const OPENCLAW_MESSAGE_TIMEOUT_MS = 60_000;
const OPENCLAW_MESSAGE_MAX_OUTPUT_BYTES = 1024 * 1024;

type OpenClawMessageRun = (args: string[]) => Promise<void>;

export type AdminBotMessageExecutorOptions = {
  command?: string;
  commandArgsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  run?: OpenClawMessageRun;
};

export function createAdminBotMessageExecutor(
  options: AdminBotMessageExecutorOptions = {},
): AdminBotActionExecutor {
  const run = options.run ?? createOpenClawMessageRunner(options);
  return {
    async execute(proposal) {
      const args = buildOpenClawMessageArgs(proposal, options.commandArgsPrefix ?? []);
      if (!args) {
        return { handled: false };
      }
      await run(args);
      return { handled: true };
    },
  };
}

function buildOpenClawMessageArgs(
  proposal: AdminBotStoredProposal,
  prefix: string[],
): string[] | undefined {
  const isSlackOnlyType =
    proposal.type === "slack.send_message" || proposal.type === "paper_publish.nudge_author";
  if (!isSlackOnlyType && proposal.type !== "member_nudge.send") {
    return undefined;
  }
  const payload = requirePayload(proposal);
  if (proposal.type === "member_nudge.send" && optionalString(payload, "channel") !== "slack") {
    // Shared with gog-executor.ts; the email-shaped half of this action type belongs there.
    return undefined;
  }
  const tool = optionalString(payload, "tool") ?? "message";
  const action = optionalString(payload, "action") ?? "send";
  if (tool !== "message" || action !== "send") {
    return undefined;
  }
  const channel = optionalString(payload, "channel") ?? "slack";
  const args = [
    ...prefix,
    "message",
    "send",
    "--channel",
    channel,
    "--target",
    requireString(payload, "target"),
    "--message",
    requireString(payload, "message"),
    "--json",
  ];
  appendOptional(args, "--account", optionalString(payload, "account"));
  appendOptional(args, "--thread-id", optionalString(payload, "threadTs"));
  appendOptional(args, "--reply-to", optionalString(payload, "replyTo"));
  if (payload.silent === true) {
    args.push("--silent");
  }
  return args;
}

function requirePayload(proposal: AdminBotStoredProposal): Record<string, unknown> {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${proposal.type} requires an object proposed_payload`);
  }
  return payload as Record<string, unknown>;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = optionalString(payload, key);
  if (!value) {
    throw new Error(`proposed_payload.${key} is required`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`proposed_payload.${key} must be a non-empty string`);
  }
  return value.trim();
}

function appendOptional(args: string[], flag: string, value: string | undefined): void {
  if (value) {
    args.push(flag, value);
  }
}

function createOpenClawMessageRunner(options: AdminBotMessageExecutorOptions): OpenClawMessageRun {
  const command = options.command ?? "openclaw";
  return async (args) => {
    try {
      await execFile(command, args, {
        env: options.env ?? process.env,
        maxBuffer: OPENCLAW_MESSAGE_MAX_OUTPUT_BYTES,
        timeout: OPENCLAW_MESSAGE_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(formatOpenClawMessageError(error), { cause: error });
    }
  };
}

function formatOpenClawMessageError(error: unknown): string {
  const failure = error as { code?: unknown; stderr?: unknown };
  if (failure?.code === "ENOENT") {
    return "openclaw executable was not found in the AdminBot service PATH";
  }
  const detail =
    typeof failure?.stderr === "string"
      ? failure.stderr
          .replace(/[\u0000-\u001f\u007f]+/gu, " ")
          .trim()
          .slice(0, 500)
      : "";
  const exitCode =
    typeof failure?.code === "number" || typeof failure?.code === "string"
      ? ` (exit ${String(failure.code)})`
      : "";
  return detail
    ? `openclaw message send failed${exitCode}: ${detail}`
    : `openclaw message send failed${exitCode}`;
}
