#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = process.argv[2] ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
const modelId = process.env.JINESIS_VLLM_MODEL ?? "nvidia/Qwen3.5-122B-A10B-NVFP4";
const modelRef = `vllm/${modelId}`;
const baseUrl = process.env.JINESIS_VLLM_BASE_URL ?? "http://127.0.0.1:8000/v1";
const apiKey = process.env.VLLM_API_KEY ?? "vllm-local";

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
      name: "Qwen3.5 122B A10B NVFP4 (Aurora)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 2048,
      compat: { thinkingFormat: "qwen-chat-template" },
    },
  ],
};

const defaultModels = { ...(config.agents?.defaults?.models ?? {}) };
defaultModels[modelRef] = {
  ...(defaultModels[modelRef] ?? {}),
  params: {
    ...(defaultModels[modelRef]?.params ?? {}),
    temperature: 0.15,
  },
};

const agentsList = (config.agents?.list ?? []).map((agent) =>
  agent.id === "adminbot"
    ? {
        ...agent,
        model: { primary: modelRef, fallbacks: [] },
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

const backupPath = `${configPath}.before-qwen35`;
fs.copyFileSync(configPath, backupPath);
fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(configPath, 0o600);

console.log(`configured=${configPath}`);
console.log(`backup=${backupPath}`);
console.log(`model=${modelRef}`);
