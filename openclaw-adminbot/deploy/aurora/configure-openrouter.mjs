#!/usr/bin/env node
// Configures OpenRouter as the single route to frontier models.
//
// Direct openai/* and anthropic/* refs are retired: one key, one billing
// surface, and no rows in the model picker that 401 because the deployment
// never had that provider's key. The OpenRouter key itself stays in the
// environment — only a SecretRef lands in openclaw.json, so agents that can
// read config never see the secret.
//
// Model metadata is spelled out because the catalog fallback reports a generic
// ~195k context for these, which silently truncates long sessions on models
// that actually carry ~1M.
//
// Usage: OPENROUTER_API_KEY must be set for the gateway; then
//   node deploy/aurora/configure-openrouter.mjs [configPath]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = process.argv[2] ?? path.join(os.homedir(), ".openclaw", "openclaw.json");

const MODELS = [
  { id: "openai/gpt-5.5", ctx: 1050000, max: 128000, cost: [5, 30] },
  { id: "openai/gpt-5.4-mini", ctx: 400000, max: 128000, cost: [0.75, 4.5] },
  { id: "anthropic/claude-opus-4.8", ctx: 1000000, max: 128000, cost: [5, 25] },
  { id: "anthropic/claude-sonnet-4.6", ctx: 1000000, max: 128000, cost: [3, 15] },
  { id: "google/gemini-3.1-pro-preview", ctx: 1048576, max: 65536, cost: [2, 12] },
];

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.models ??= {};
config.models.providers ??= {};
config.agents ??= {};
config.agents.defaults ??= {};

config.models.providers.openrouter = {
  ...(config.models.providers.openrouter ?? {}),
  apiKey: { source: "env", provider: "default", id: "OPENROUTER_API_KEY" },
  models: MODELS.map((m) => ({
    id: m.id,
    name: m.id,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: m.cost[0], output: m.cost[1], cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.ctx,
    maxTokens: m.max,
  })),
};

const retained = {};
for (const [ref, entry] of Object.entries(config.agents.defaults.models ?? {})) {
  if (ref.startsWith("openai/") || ref.startsWith("anthropic/")) {
    continue;
  }
  retained[ref] = entry;
}
for (const m of MODELS) {
  retained[`openrouter/${m.id}`] ??= {};
}
config.agents.defaults.models = retained;

const backupPath = `${configPath}.before-openrouter`;
fs.copyFileSync(configPath, backupPath);
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(configPath, 0o600);

console.log(`configured=${configPath}`);
console.log(`backup=${backupPath}`);
for (const ref of Object.keys(retained)) {
  console.log(`  ${ref}`);
}
