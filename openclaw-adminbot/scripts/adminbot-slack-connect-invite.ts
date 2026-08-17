// Mints one Slack Connect invite, out-of-process.
//
// Reads one JSON object from stdin: { email, channelId }. Writes exactly one JSON line to stdout
// -- { ok: true, url } or { ok: false, error } -- and exits 0/1 to match, the same contract as
// scripts/adminbot-dcs-form-submit.ts.
//
// This exists because the production launcher cannot import it directly. start-adminbot.mjs runs
// under plain node and resolves everything else from dist/, but extensions/slack is deliberately
// excluded from the bundle (`openclaw.build.bundledDist: false`, and `!dist/extensions/slack/**`
// in the root package files), so `extensions/slack/api.js` exists only as TypeScript source. The
// launcher's dynamic import of it therefore threw MODULE_NOT_FOUND on every real send, and only
// ever appeared to work under `pnpm adminbot:dev`, which runs through tsx and maps .js to .ts.
//
// Spawning a tsx script is how this repo already reaches TypeScript from the built launcher --
// see runEmailAutomation in start-adminbot.mjs, and the injected dcsFormScriptPath and
// openReviewScriptPath -- so this follows that seam rather than inventing another.
type Request = { email?: unknown; channelId?: unknown };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  const request = (raw ? JSON.parse(raw) : {}) as Request;
  const email = typeof request.email === "string" ? request.email.trim() : "";
  const channelId = typeof request.channelId === "string" ? request.channelId.trim() : "";
  if (!email || !channelId) {
    throw new Error("email and channelId are both required");
  }

  // Reuses the hourly automation's resolver rather than calling resolveSlackAccount directly.
  // The bot token is stored as a SecretRef ("env:default:SLACK_BOT_TOKEN"), and resolveSlackAccount
  // on a raw config throws UnresolvedSecretInputError -- which is the second half of why this send
  // never worked. That resolver already does loadConfig({ skipPluginValidation: true }) plus the
  // SecretRef pass, and it is the same call the trial-invite path has been making successfully.
  // Imported here rather than at module scope so a load failure is reported like any other:
  // top-level imports throw before the handler below can run, which produced a script that exited
  // non-zero having written nothing at all, and a launcher that could only say "no result".
  const { getSlackWriteClient } = await import("../extensions/slack/api.js");
  const { resolveEmailAutomationSlackAccount } = await import("./adminbot-email-automation.ts");
  const account = await resolveEmailAutomationSlackAccount();
  if (!account.botToken) {
    throw new Error("Slack bot token is not configured; cannot mint a Slack Connect invite");
  }
  const response = (await getSlackWriteClient(account.botToken).apiCall(
    "conversations.inviteShared",
    { channel: channelId, emails: [email], external_limited: true },
  )) as { url?: unknown; invite?: { url?: unknown } } | undefined;
  const url = response?.url ?? response?.invite?.url;
  if (typeof url !== "string" || !url) {
    throw new Error("Slack did not return an invite url");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, url })}\n`);
}

try {
  await main();
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
