import os from "node:os";
import path from "node:path";
import {
  createAdminBotMessageExecutor,
  createAdminBotMockService,
  createAdminBotOverleafExecutor,
  createAdminBotSocialExecutor,
  createCompositeAdminBotExecutor,
  createGogAdminBotExecutor,
} from "./dist/extensions/adminbot/api.js";

try {
  process.loadEnvFile(path.join(os.homedir(), ".openclaw/.env"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

console.log(`AdminBot NVIDIA NIM configured: ${process.env.NVIDIA_API_KEY ? "yes" : "no"}`);

const service = createAdminBotMockService({
  databasePath: "./state/adminbot.sqlite",
  auditRetentionDays: 30,
  executor: createCompositeAdminBotExecutor([
    createAdminBotOverleafExecutor(),
    createAdminBotSocialExecutor(),
    createAdminBotMessageExecutor({
      command: process.execPath,
      commandArgsPrefix: ["openclaw.mjs"],
    }),
    createGogAdminBotExecutor(),
  ]),
  sensitiveInfoPath: path.join(os.homedir(), ".openclaw/adminbot-sensitive-information.md"),
});

await service.listen(8765, "127.0.0.1");
console.log(
  "AdminBot service with live gog/social/overleaf/message execution running on http://127.0.0.1:8765",
);

// Keep the service alive even when launched detached without an interactive stdin.
setInterval(() => {}, 2 ** 31 - 1);
