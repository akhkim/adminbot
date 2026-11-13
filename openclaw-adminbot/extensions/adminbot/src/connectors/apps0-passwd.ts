/**
 * The department's own account namespace, read live from apps0's `/etc/passwd` whenever a DCS
 * username is about to be written to the roster sheet.
 *
 * The roster sheet and AdminBot's roster only know the lab's accounts. DCS mints every account in
 * the department under one namespace, so `luca`, `van` and `vincent` were proposed as free on the
 * sheet and then refused by the sysadmin because somebody outside the lab already held them. The
 * login names on `apps0.cs.toronto.edu` are that namespace.
 *
 * Read over non-interactive SSH as `cut -d: -f1 /etc/passwd`, so only the login column leaves
 * apps0 (no real names, homes or shells), and nothing from this side -- no candidate name -- is
 * ever put into the remote command.
 *
 * It fails closed. An SSH failure, a timeout or an implausibly short answer throws, and the filing
 * that asked refuses to pick a name rather than proposing one nobody checked -- which is exactly
 * the failure this exists to stop.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** The host whose `/etc/passwd` is the department's account list. */
export const APPS0_PASSWD_DEFAULT_HOST = "apps0.cs.toronto.edu";

/**
 * The fewest login names a real answer has.
 *
 * The department's passwd carries thousands of entries. A handful is a truncated read or the wrong
 * host's file, and "nobody holds `luca`" against it would be the same unchecked guess.
 */
export const APPS0_PASSWD_MIN_ENTRIES = 100;

/**
 * How long one read is reused.
 *
 * Long enough that a backfill filing a dozen rows makes one SSH round-trip rather than a dozen,
 * short enough that every filing is checked against the department as it stands now.
 */
export const APPS0_PASSWD_CACHE_MS = 60_000;

const SSH_TIMEOUT_MS = 30_000;
const SSH_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A unix login name as passwd spells it (lowercase; `$` only as a machine account's suffix). */
const LOGIN_NAME = /^[a-z_][a-z0-9_.-]*\$?$/u;

/**
 * The login names in a passwd-shaped text.
 *
 * Accepts full passwd lines (`name:x:uid:gid:gecos:home:shell`) or bare names one per line, which
 * is what `cut -d: -f1` returns. Blank lines, `#` comments and NIS `+`/`-` entries are not accounts
 * and are skipped, as is anything that is not a valid login name.
 */
export function parseApps0PasswdUsernames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const field = line.split(":")[0]?.trim().toLowerCase() ?? "";
    if (field && LOGIN_NAME.test(field)) {
      names.add(field);
    }
  }
  return [...names];
}

/** Runs the remote read and gives back its stdout. Injected so a test is not a network. */
export type Apps0PasswdRunner = (host: string) => Promise<string>;

/** The production runner: `ssh -o BatchMode=yes <host> cut -d: -f1 /etc/passwd`. */
export const sshApps0PasswdRunner: Apps0PasswdRunner = async (host) => {
  const { stdout } = await execFile(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      // A host name that begins with "-" must never be read as an option.
      "--",
      host,
      "cut -d: -f1 /etc/passwd",
    ],
    { timeout: SSH_TIMEOUT_MS, maxBuffer: SSH_MAX_OUTPUT_BYTES, encoding: "utf8" },
  );
  return stdout;
};

export type Apps0PasswdReaderOptions = {
  /** Defaults to apps0.cs.toronto.edu. */
  host?: string;
  run?: Apps0PasswdRunner;
  minEntries?: number;
  cacheMs?: number;
  now?: () => number;
};

/**
 * A reader that answers the department's taken login names, or throws saying why it cannot.
 *
 * Only a successful read is cached. A failure is never remembered, so the next filing tries again.
 */
export function createApps0PasswdReader(
  options: Apps0PasswdReaderOptions = {},
): () => Promise<string[]> {
  const host = options.host?.trim() || APPS0_PASSWD_DEFAULT_HOST;
  const run = options.run ?? sshApps0PasswdRunner;
  const minEntries = options.minEntries ?? APPS0_PASSWD_MIN_ENTRIES;
  const cacheMs = options.cacheMs ?? APPS0_PASSWD_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; names: string[] } | undefined;
  return async () => {
    if (cached && now() - cached.at < cacheMs) {
      return cached.names;
    }
    let stdout: string;
    try {
      stdout = await run(host);
    } catch (error) {
      throw new Error(
        `could not read /etc/passwd on ${host} over ssh, so no DCS username can be checked against the department: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const names = parseApps0PasswdUsernames(stdout);
    if (names.length < minEntries) {
      throw new Error(
        `/etc/passwd on ${host} gave only ${names.length} login names, too few to be the department's; refusing to pick a DCS username against it`,
      );
    }
    cached = { at: now(), names };
    return names;
  };
}
