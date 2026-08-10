/**
 * Public sandbox barrel for agent runtime code.
 *
 * Keep sandbox implementation modules behind this export surface so callers use
 * the same config, backend, Docker, SSH, filesystem, and policy contracts.
 */
export {
  resolveSandboxBrowserConfig,
  resolveSandboxConfigForAgent,
  resolveSandboxDockerConfig,
  resolveSandboxPruneConfig,
  resolveSandboxScope,
} from "./config.js";
export {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
} from "./constants.js";
export { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./context.js";
export {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  registerSandboxBackend,
  requireSandboxBackendFactory,
} from "./backend.js";

export { buildSandboxCreateArgs, isDockerDaemonUnavailable } from "./docker.js";
export {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
  type SandboxBrowserInfo,
  type SandboxContainerInfo,
} from "./manage.js";
export {
  formatSandboxToolPolicyBlockedMessage,
  resolveSandboxRuntimeStatus,
} from "./runtime-status.js";

export { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./tool-policy.js";
export type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.js";
export {
  buildExecRemoteCommand,
  buildRemoteCommand,
  buildSshSandboxArgv,
  buildValidatedExecRemoteCommand,
  createSshSandboxSessionFromConfigText,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  shellEscape,
  uploadDirectoryToSshTarget,
} from "./ssh.js";
export { sanitizeEnvVars } from "./sanitize-env-vars.js";
export { createRemoteShellSandboxFsBridge } from "./remote-fs-bridge.js";
export { createWritableRenameTargetResolver } from "./fs-bridge-rename-targets.js";
export { resolveWritableRenameTargets } from "./fs-bridge-rename-targets.js";
export { resolveWritableRenameTargetsForBridge } from "./fs-bridge-rename-targets.js";

export type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirResolver,
} from "./backend.js";
export type { RemoteShellSandboxHandle } from "./remote-fs-bridge.js";
export type { RunSshSandboxCommandParams, SshSandboxSession, SshSandboxSettings } from "./ssh.js";

export type {
  SandboxBrowserConfig,
  SandboxBrowserContext,
  SandboxConfig,
  SandboxContext,
  SandboxDockerConfig,
  SandboxPruneConfig,
  SandboxScope,
  SandboxSshConfig,
  SandboxToolPolicy,
  SandboxToolPolicyResolved,
  SandboxToolPolicySource,
  SandboxWorkspaceAccess,
  SandboxWorkspaceInfo,
} from "./types.js";
