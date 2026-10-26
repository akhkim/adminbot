import path from "node:path";

/**
 * The environment start-adminbot.mjs gives the tsx scripts it runs out-of-process.
 *
 * Kept out of the launcher so it can be tested: the launcher starts the host at module scope.
 *
 * `node_modules/.bin/tsx` starts with `#!/usr/bin/env node`, so it needs `node` on PATH. On Aurora
 * the systemd unit runs node by absolute path (`~/.local/bin/node`) under systemd's default PATH,
 * which has no node on it: every Slack Connect invite died with "/usr/bin/env: 'node': No such
 * file or directory", and each onboarding guide waiting on one was withheld as simulated. The cron
 * jobs never hit this because the gateway hands its children a PATH that already has node. Putting
 * the launcher's own node first also keeps the child on the service's runtime rather than whichever
 * node a PATH entry happens to hold.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [execPath]
 * @returns {NodeJS.ProcessEnv}
 */
export function tsxChildEnv(env = process.env, execPath = process.execPath) {
  const nodeDir = path.dirname(execPath);
  const rest = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry !== "" && entry !== nodeDir);
  return { ...env, PATH: [nodeDir, ...rest].join(path.delimiter) };
}
