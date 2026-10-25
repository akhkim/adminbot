/**
 * Reads what scripts/adminbot-slack-connect-invite.ts left behind, for start-adminbot.mjs.
 *
 * Kept out of the launcher so it can be tested: the launcher starts the host at module scope.
 *
 * The helper's contract is one JSON line on stdout, `{ ok: true, url, invite_id? }` or
 * `{ ok: false, error }`. `url` is "" when Slack delivered the invite to an existing Slack account
 * and returned only an invite id -- that is a sent invite, and the onboarding copy already has a
 * sentence for it, so it must not be reported as a failure.
 *
 * @param {{ stdout: string, stderr: string, code?: number | null, signal?: string | null, spawnError?: Error }} run
 * @returns {{ url: string, inviteId?: string }}
 */
export function readSlackConnectInviteResult({ stdout, stderr, code, signal, spawnError }) {
  const line = stdout.trim().split(/\r?\n/u).findLast(Boolean);
  if (!line) {
    const detail =
      spawnError?.message ??
      // A timeout kill reports only the signal, so name it rather than printing "exit null".
      (signal ? `killed by ${signal} (timed out?)` : undefined) ??
      stderr.trim().split(/\r?\n/u).findLast(Boolean) ??
      `exit ${code}`;
    throw new Error(`slack connect invite produced no result: ${detail}`);
  }
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    throw new Error(
      `slack connect invite returned something other than JSON: ${line.slice(0, 200)}`,
    );
  }
  if (!payload?.ok) {
    throw new Error(payload?.error ?? "slack connect invite failed");
  }
  const url = typeof payload.url === "string" ? payload.url : "";
  const inviteId =
    payload.invite_id === undefined || payload.invite_id === null || payload.invite_id === ""
      ? undefined
      : String(payload.invite_id);
  if (!url && !inviteId) {
    throw new Error("slack connect invite reported success without an invite url or invite id");
  }
  return inviteId ? { url, inviteId } : { url };
}
