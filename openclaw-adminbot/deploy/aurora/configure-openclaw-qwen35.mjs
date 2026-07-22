#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = process.argv[2] ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
const modelId = process.env.JINESIS_VLLM_MODEL ?? "nvidia/Qwen3.5-122B-A10B-NVFP4";
const modelRef = `vllm/${modelId}`;
const baseUrl = process.env.JINESIS_VLLM_BASE_URL ?? "http://127.0.0.1:8000/v1";
const contextWindow = Number(process.env.JINESIS_VLLM_CONTEXT_WINDOW ?? "65536");
const apiKey = {
  source: "env",
  provider: "default",
  id: "VLLM_API_KEY",
};
const adminBotTools = ["adminbot_reimbursement_converse", "adminbot_reimbursement_generate"];

const raw = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(raw);
const providers = { ...(config.models?.providers ?? {}) };
providers.vllm = {
  ...(providers.vllm ?? {}),
  baseUrl,
  apiKey,
  api: "openai-completions",
  timeoutSeconds: 900,
  models: [
    {
      id: modelId,
      name: modelId,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: 16384,
      compat: { thinkingFormat: "qwen-chat-template" },
    },
  ],
};

const defaultModels = { ...(config.agents?.defaults?.models ?? {}) };
defaultModels[modelRef] = {
  ...(defaultModels[modelRef] ?? {}),
  params: {
    ...(defaultModels[modelRef]?.params ?? {}),
    temperature: 0.6,
    topP: 0.95,
  },
};

const agentsList = (config.agents?.list ?? []).map((agent) =>
  agent.id === "adminbot"
    ? {
        ...agent,
        model: { primary: modelRef, fallbacks: [] },
        tools: {
          ...agent.tools,
          alsoAllow: [...new Set([...(agent.tools?.alsoAllow ?? []), ...adminBotTools])],
        },
      }
    : agent,
);

const next = {
  ...config,
  models: {
    ...config.models,
    providers,
  },
  agents: {
    ...config.agents,
    defaults: {
      ...config.agents?.defaults,
      models: defaultModels,
    },
    list: agentsList,
  },
};

const backupPath = `${configPath}.before-qwen35-122b`;
fs.copyFileSync(configPath, backupPath);
fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(configPath, 0o600);

console.log(`configured=${configPath}`);
console.log(`backup=${backupPath}`);
console.log(`model=${modelRef}`);
