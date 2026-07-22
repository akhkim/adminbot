import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createAdminBotMessageExecutor,
  createAdminBotMockService,
  createAdminBotReimbursementWorkflow,
  createAdminBotOverleafExecutor,
  createAdminBotSocialExecutor,
  createCompositeAdminBotExecutor,
  createGogAdminBotExecutor,
} from "./dist/extensions/adminbot/api.js";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

try {
  process.loadEnvFile(path.join(os.homedir(), ".openclaw/.env"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

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
  emailAutomationRunner: runEmailAutomationProcess,
  reimbursementWorkflow: createAdminBotReimbursementWorkflow({
    formScriptPath: path.join(repoRoot, "scripts/adminbot-reimbursement-from-email.py"),
  }),
});

async function runEmailAutomationProcess() {
  const executable = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const script = path.join(repoRoot, "scripts", "adminbot-email-automation.ts");
  const { stdout } = await execFileAsync(executable, [script], {
    cwd: repoRoot,
    env: { ...process.env, ADMINBOT_EMAIL_ALLOW_PARTIAL: "1" },
    timeout: 30 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!output) throw new Error("email automation returned no completion summary");
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("email automation returned an invalid completion summary");
  }
}

await service.listen(8765, "127.0.0.1");
console.log(
  "AdminBot service with live gog/social/overleaf/message execution running on http://127.0.0.1:8765",
);

// Keep the service alive even when launched detached without an interactive stdin.
setInterval(() => {}, 2 ** 31 - 1);
