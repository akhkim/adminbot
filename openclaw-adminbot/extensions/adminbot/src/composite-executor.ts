import type { AdminBotStoredProposal } from "./contracts.js";
import type { AdminBotActionExecutor } from "./service-core.js";

export function createCompositeAdminBotExecutor(
  executors: AdminBotActionExecutor[],
): AdminBotActionExecutor {
  return {
    async execute(proposal: AdminBotStoredProposal) {
      for (const executor of executors) {
        const result = await executor.execute(proposal);
        if (result.handled) {
          return result;
        }
      }
      return { handled: false };
    },
  };
}
