import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The database the running AdminBot service reads: meetings, papers, members.
 *
 * Has to match `createAdminBotHost` (extensions/adminbot/host/main.ts), which opens
 * `<release>/state/adminbot.sqlite` -- on Aurora a symlink into the deploy root's state dir. These
 * scripts used to default to `~/.openclaw/state/adminbot.sqlite` instead, which is only the same
 * file while the release's `state` link happens to point there. Once the deploy root moved, every
 * recording notice the hourly email pass filed went into a database the Meetings tab never reads:
 * filed, marked completed, and invisible.
 *
 * `ADMINBOT_DB_PATH` still overrides it, as it always did.
 */
export function adminbotServiceDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADMINBOT_DB_PATH?.trim() || path.join(REPO_ROOT, "state", "adminbot.sqlite");
}
