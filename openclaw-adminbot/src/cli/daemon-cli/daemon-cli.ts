// Public daemon CLI barrel retained for gateway service command compatibility.
export { registerDaemonCli } from "./register.js";
export { addGatewayServiceCommands } from "./register-service-commands.js";
export {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "./runners.js";
export type { DaemonInstallOptions, DaemonStatusOptions, GatewayRpcOpts } from "./types.js";
