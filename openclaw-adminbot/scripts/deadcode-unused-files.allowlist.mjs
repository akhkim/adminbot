// Intentional Knip unused-file findings. These are dynamic entrypoints,
// generated/build inputs, manifest-discovered plugin surfaces, live-test
// helpers, or package bridge files that static production scanning cannot see.
// start-adminbot.mjs is the production service launcher: systemd runs it directly, so nothing
// in the repo imports it.
export const KNIP_UNUSED_FILE_ALLOWLIST = [];

// Knip can disagree across supported local/CI platforms for files that are
// only reachable through test-only import graphs, sparse-checkout proof
// workspaces, dynamic entrypoints, manifest-discovered plugin surfaces, or
// package bridge files. Ignore these when reported, but do not require them
// to be reported.
export const KNIP_OPTIONAL_UNUSED_FILE_ALLOWLIST = [
  "extensions/memory-core/src/memory-tool-manager-mock.ts",
  // oxlint-disable-next-line eslint/no-warning-comments -- the triage marker is the point
  // TODO(refactor): triage — surfaced once config/knip.config.ts stopped pointing
  // packages/* at nonexistent index.js entries. It is a worker child resolved by
  // string from embeddings-worker.ts and listed in tsdown.config.ts, so it is
  // reachable, but confirm before treating it as permanently allowlisted.
  "packages/memory-host-sdk/src/host/embeddings-worker-child.ts",
  "src/agents/subagents/subagent-registry.runtime.ts",
  "src/auto-reply/reply/get-reply/get-reply.test-loader.ts",
  "src/cli/daemon-cli/daemon-cli-compat.ts",
  "src/commands/doctor/shared/deprecation-compat.ts",
  "src/config/doc-baseline.runtime.ts",
  "src/config/doc-baseline.ts",
  "src/gateway/gateway-cli-backend.live-helpers.ts",
  "src/gateway/gateway-cli-backend.live-probe-helpers.ts",
  "src/gateway/gateway-codex-harness.live-helpers.ts",
  "src/plugins/build-smoke-entry.ts",
  "src/plugins/contracts/host-hook-fixture.ts",
  "src/plugins/contracts/rootdir-boundary-canary.ts",
  "src/plugins/runtime/runtime-sidecar-paths-baseline.ts",
  "src/tasks/task-registry-control.runtime.ts",
  // The guidebook corpus is built by scripts/adminbot-guidebook-sync.ts, and
  // scripts/** sits in knip's ignoreFiles, so the only importer is invisible to
  // the static pass. The service imports guidebook/ask.ts, not these two.
  "extensions/adminbot/src/guidebook/chunk.ts",
  "extensions/adminbot/src/guidebook/sync.ts",
  "start-adminbot.mjs",
  "ui/src/ui/browser-redact.ts",
];
