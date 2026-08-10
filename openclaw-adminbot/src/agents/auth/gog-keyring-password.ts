// Requests a one-shot GOG keyring password from the operator approval UI.
import type { OpenClawConfig } from "../../config/types/openclaw.js";
import { withOperatorApprovalsGatewayClient } from "../../gateway/operator-approvals-client.js";

const GOG_KEYRING_PASSWORD = "GOG_KEYRING_PASSWORD";
const GOG_COMMAND_RE =
  /(?:^|[;&|()]\s*)(?:\s*)(?:[^\s;&|()"'`]+[/\\])?(?:gog|gog-wrapper)(?:\s|$)/u;

export function commandUsesGog(command: string | undefined): boolean {
  return typeof command === "string" && GOG_COMMAND_RE.test(command);
}

export async function requestGogKeyringPassword(params: {
  command: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): Promise<string | undefined> {
  if (!params.config) {
    return undefined;
  }
  return await withOperatorApprovalsGatewayClient(
    {
      config: params.config,
      clientDisplayName: "GOG keyring password prompt",
    },
    async (client) => {
      const result = (await client.request("operator.secret.request", {
        title: "GOG keyring password required",
        description: "Enter GOG_KEYRING_PASSWORD to unlock the local gog keyring for this command.",
        variableName: GOG_KEYRING_PASSWORD,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        timeoutMs: 300_000,
      })) as { value?: unknown; cancelled?: unknown };
      if (result.cancelled === true || typeof result.value !== "string") {
        return undefined;
      }
      return result.value;
    },
  );
}

export { GOG_KEYRING_PASSWORD };
