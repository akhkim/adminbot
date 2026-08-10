/**
 * Installs bundled plugin registration contract cases used across provider tests.
 */
import { describePluginRegistrationContract } from "./plugin-registration-contract.js";

type PluginRegistrationContractParams = Parameters<typeof describePluginRegistrationContract>[0];

export const pluginRegistrationContractCases = {
  brave: {
    pluginId: "brave",
    webSearchProviderIds: ["brave"],
  },
  nvidia: {
    pluginId: "nvidia",
    providerIds: ["nvidia"],
    manifestAuthChoice: {
      pluginId: "nvidia",
      choiceId: "nvidia-api-key",
      choiceLabel: "NVIDIA API key",
      groupId: "nvidia",
      groupLabel: "NVIDIA",
      groupHint: "Direct API key",
    },
  },
  ollama: {
    pluginId: "ollama",
    providerIds: ["ollama", "ollama-cloud"],
    webSearchProviderIds: ["ollama"],
  },
  openrouter: {
    pluginId: "openrouter",
    providerIds: ["openrouter"],
  },
} satisfies Record<string, PluginRegistrationContractParams>;
