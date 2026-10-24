// Read-only workspace lookup for the host's directory sync. Resolves existing SecretRefs
// through the same account resolver as email automation; returns only requested email matches.
import { isMainModule } from "./lib/is-main-module.mjs";

type SlackDirectoryClient = {
  apiCall(method: string, params: Record<string, unknown>): Promise<unknown>;
};

export async function lookupSlackEmails(client: SlackDirectoryClient, emails: readonly string[]) {
  const wanted = new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  const cursors = new Set<string>();
  let emailVisible = false;
  let cursor: string | undefined;
  if (!wanted.size) {
    return [];
  }
  do {
    const page = (await client.apiCall("users.list", {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as {
      ok?: boolean;
      error?: string;
      members?: Array<{
        id?: string;
        deleted?: boolean;
        is_bot?: boolean;
        is_app_user?: boolean;
        profile?: { email?: string };
      }>;
      response_metadata?: { next_cursor?: string };
    };
    if (!page?.ok || !Array.isArray(page.members)) {
      throw new Error(`Slack directory lookup failed: ${page?.error ?? "invalid response"}`);
    }
    for (const member of page.members) {
      const email = member.profile?.email?.trim().toLowerCase();
      if (email && !member.deleted && !member.is_bot && !member.is_app_user) {
        emailVisible = true;
      }
      if (
        member.deleted ||
        member.is_bot ||
        member.is_app_user ||
        !email ||
        !wanted.has(email) ||
        !member.id ||
        !/^[UW][A-Z0-9]+$/u.test(member.id)
      ) {
        continue;
      }
      if (matches.has(email) && matches.get(email) !== member.id) {
        ambiguous.add(email);
      } else {
        matches.set(email, member.id);
      }
    }
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
    if (cursor && cursors.has(cursor)) {
      throw new Error("Slack directory returned a repeated cursor");
    }
    if (cursor) {
      cursors.add(cursor);
    }
  } while (cursor);
  if (!emailVisible) {
    throw new Error(
      "Slack directory email addresses are unavailable; check users:read.email permission",
    );
  }
  return [...matches]
    .filter(([email]) => !ambiguous.has(email))
    .map(([email, id]) => ({ id, raw: { profile: { email } } }));
}

async function main() {
  const emails: unknown = JSON.parse(process.argv[2] ?? "[]");
  if (
    !Array.isArray(emails) ||
    emails.length > 10000 ||
    emails.some((email) => typeof email !== "string")
  ) {
    throw new Error("expected an array of email addresses");
  }
  const { resolveEmailAutomationSlackAccount } = await import("./adminbot-email-automation.ts");
  const { getSlackWriteClient } = await import("../extensions/slack/api.js");
  const account = await resolveEmailAutomationSlackAccount();
  if (!account.botToken) {
    throw new Error("Slack bot token is not configured");
  }
  const result = await lookupSlackEmails(getSlackWriteClient(account.botToken), emails);
  console.log(JSON.stringify(result));
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Slack directory lookup failed");
    process.exitCode = 1;
  });
}
