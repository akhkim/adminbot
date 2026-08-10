// Lazy subagent-status facade. Keeps subagent registries out of the base status
// import path until the command actually needs to render descendant runs.
export { listControlledSubagentRuns } from "../agents/subagents/subagent-control.js";
export { countPendingDescendantRuns } from "../agents/subagents/subagent-registry.js";
export { buildSubagentsStatusLine } from "../auto-reply/reply/commands/commands-status-subagents.js";
