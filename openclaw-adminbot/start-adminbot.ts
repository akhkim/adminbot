import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCompositeAdminBotExecutor } from "./extensions/adminbot/src/composite-executor.ts";
import { createGogAdminBotExecutor } from "./extensions/adminbot/src/gog-executor.ts";
import { createAdminBotMessageExecutor } from "./extensions/adminbot/src/message-executor.ts";
import { createAdminBotMockService } from "./extensions/adminbot/src/mock-service.ts";
import { createAdminBotOverleafExecutor } from "./extensions/adminbot/src/overleaf-executor.ts";
import { createAdminBotReimbursementWorkflow } from "./extensions/adminbot/src/reimbursement-workflow.ts";
import { createAdminBotSocialExecutor } from "./extensions/adminbot/src/social-executor.ts";
import { runEmailAutomation } from "./scripts/adminbot-email-automation.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
loadOpenClawEnv();
console.log(`AdminBot NVIDIA NIM configured: ${process.env.NVIDIA_API_KEY ? "yes" : "no"}`);
const service = createAdminBotMockService({
  databasePath: path.join(repoRoot, "state/adminbot.sqlite"),
  auditRetentionDays: 30,
  executor: createCompositeAdminBotExecutor([
    createAdminBotOverleafExecutor(),
    createAdminBotSocialExecutor(),
    createAdminBotMessageExecutor({
      command: process.execPath,
      commandArgsPrefix: [path.join(repoRoot, "openclaw.mjs")],
    }),
    createGogAdminBotExecutor(),
  ]),
  sensitiveInfoPath: path.join(os.homedir(), ".openclaw/adminbot-sensitive-information.md"),
  emailAutomationRunner: runEmailAutomation,
  reimbursementWorkflow: createAdminBotReimbursementWorkflow({
    formScriptPath: path.join(repoRoot, "scripts/adminbot-reimbursement-from-email.py"),
  }),
});

await service.listen(8765, "127.0.0.1");
console.log(
  "AdminBot service with live gog/social/overleaf/message execution running on http://127.0.0.1:8765",
);

// Keep the service alive even when launched detached without an interactive stdin.
setInterval(() => {}, 2 ** 31 - 1);

function loadOpenClawEnv(): void {
  try {
    process.loadEnvFile(path.join(os.homedir(), ".openclaw/.env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
