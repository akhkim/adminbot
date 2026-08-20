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

type SlackClient = {
  apiCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

/**
 * A channel id for what the caller named.
 *
 * `conversations.inviteShared` takes an id, but the onboarding plan and the tab both work in names
 * -- "#proj-alg-circuit" is what the email says and what an operator types. Ids pass through
 * untouched; anything else is looked up, paging because a workspace this size does not fit in one
 * response and the project channels sort late.
 */
async function resolveChannelId(client: SlackClient, channel: string): Promise<string> {
  if (/^[CGD][A-Z0-9]{2,}$/u.test(channel)) {
    return channel;
  }
  const name = channel.replace(/^#/u, "").trim();
  if (!name) {
    throw new Error("a channel name or id is required");
  }
  let cursor: string | undefined;
  do {
    const page = (await client.apiCall("conversations.list", {
      limit: 1000,
      exclude_archived: true,
      types: "public_channel,private_channel",
      ...(cursor ? { cursor } : {}),
    })) as {
      channels?: { id?: string; name?: string }[];
      response_metadata?: { next_cursor?: string };
    };
    const match = page.channels?.find((entry) => entry.name === name);
    if (match?.id) {
      return match.id;
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  throw new Error(`no Slack channel named #${name} that this bot can see`);
}

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
  const client = getSlackWriteClient(account.botToken) as SlackClient;
  const resolved = await resolveChannelId(client, channelId);
  const response = (await client.apiCall("conversations.inviteShared", {
    channel: resolved,
    emails: [email],
    external_limited: true,
  })) as
    | { url?: unknown; invite_id?: unknown; invite?: { url?: unknown; id?: unknown } }
    | undefined;
  // Slack does not always hand back a shareable url: when the address belongs to someone who
  // already has a Slack account, the invite is delivered to them directly and the response carries
  // only an invite_id. That is a sent invite, not a failure -- treating it as one withheld the
  // email while Slack had already invited the person.
  const url = response?.url ?? response?.invite?.url;
  const inviteId = response?.invite_id ?? response?.invite?.id;
  if ((typeof url !== "string" || !url) && !inviteId) {
    throw new Error("Slack neither returned an invite url nor an invite id");
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, url: typeof url === "string" ? url : "", ...(inviteId ? { invite_id: inviteId } : {}) })}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
