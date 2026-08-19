// Rehearses an onboarding batch without sending anything.
//
// The point is that it is the real send path: the same composer, the same required-value checks,
// the same environment resolution, the same order of operations. Only the four things that reach
// the outside world -- Gmail, Drive, Slack Connect, the DCS form -- are replaced with recorders, so
// what this prints is what a real run would do, one step before it does it.
//
// It must run where the configuration lives, which is the service host: half of what it checks is
// whether ADMINBOT_* is actually set there. On Aurora:
//
//   export PATH="$HOME/.local/bin:$PATH"   # node lives here; `ssh host 'cmd'` will not find it
//   cd ~/services/openclaw-adminbot/current
//   set -a; . ~/.config/jinesis-adminbot/adminbot.env; set +a
//   node --import tsx scripts/adminbot-onboarding-dry-run.ts --plan ~/onboarding-plan.json
//
// The plan file is a JSON array of sends and stays out of this repo: it carries names and
// addresses, and this repo is public.
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveGogExecutable } from "../extensions/adminbot/src/connectors/gog.js";
import type { AdminBotExternalCollaboratorSubgroup } from "../extensions/adminbot/src/contracts/actions.js";
import { collaboratorSubgroupAccess } from "../extensions/adminbot/src/workflows/members/collaborator-subgroups.js";
import { findOnboardingTemplate } from "../extensions/adminbot/src/workflows/onboarding/emails.js";
import {
  createAdminBotOnboardingSender,
  type AdminBotOnboardingSendRequest,
} from "../extensions/adminbot/src/workflows/onboarding/guide-sender.js";
import { driveWorkspaceFolderName } from "../extensions/adminbot/src/workflows/onboarding/guide.js";

type PlannedSend = AdminBotOnboardingSendRequest & {
  /** Channels the send invites them to; carried on the request itself. */
  slack_project_channels?: readonly string[];
  /** The matrix row whose follow-up access this send implies, when the person is external. */
  subgroup?: AdminBotExternalCollaboratorSubgroup;
  /** Free-text reminder of why this send is shaped the way it is; printed, never sent. */
  note?: string;
};

function parseArgs(argv: readonly string[]): { plan: string; preflight: boolean } {
  const planFlag = argv.indexOf("--plan");
  if (planFlag === -1 || !argv[planFlag + 1]) {
    throw new Error("usage: adminbot-onboarding-dry-run.ts --plan <plan.json> [--preflight]");
  }
  return { plan: argv[planFlag + 1] as string, preflight: argv.includes("--preflight") };
}

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Checks the machinery the batch actually depends on, using read-only calls only.
 *
 * Composing proves the copy is sendable; it proves nothing about whether Gmail is still authorized
 * or the Slack token still works, because the dry run replaces both with recorders. This asks them
 * directly: `gog --version` for the binary, Slack's own `auth.test`, and `conversations.info` for
 * the channel invites are minted against. Nothing here writes, sends or invites.
 */
async function preflight(plan: readonly PlannedSend[]): Promise<boolean> {
  let ok = true;
  const fail = (line: string) => {
    ok = false;
    console.log(`  FAIL  ${line}`);
  };
  const pass = (line: string) => console.log(`  ok    ${line}`);

  // What each send will actually do is decided by the copy it carries -- the edit if there is one,
  // the stored template otherwise -- which is the same rule the sender itself applies.
  const copyOf = (entry: PlannedSend): string =>
    entry.body_override ?? findOnboardingTemplate(entry.template_id)?.body ?? "";
  const needsSlack = plan.filter((entry) => copyOf(entry).includes("{slack_connect_link}")).length;
  const needsDrive = plan.filter((entry) => copyOf(entry).includes("{drive_folder_link}")).length;
  const projectChannels = [...new Set(plan.flatMap((entry) => entry.slack_project_channels ?? []))];
  console.log("Preflight — live dependencies for this batch");
  console.log(
    `  ${plan.length} sends: all need Gmail, ${needsSlack} mint a Slack Connect invite, ${needsDrive} create a Drive folder`,
  );
  console.log(
    `  project-channel invites: ${projectChannels.length} distinct channel(s) across the batch`,
  );
  console.log("");

  console.log("Gmail (gog)");
  const gog = resolveGogExecutable();
  if (gog !== "gog" && !existsSync(gog)) {
    fail(`resolved to ${gog}, which does not exist`);
  } else {
    try {
      const { stdout } = await execFile(gog, ["--version"], { timeout: 30_000 });
      pass(`${gog} — ${stdout.trim().split("\n")[0]}`);
    } catch (error) {
      fail(`${gog} would not run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const account = process.env.GOG_ACCOUNT?.trim();
  console.log(
    account
      ? `  ok    GOG_ACCOUNT=${account}`
      : "  note  GOG_ACCOUNT unset — gog sends from its own default account",
  );
  console.log("");

  console.log("Slack Connect");
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const inviteScript = path.join(REPO_ROOT, "scripts", "adminbot-slack-connect-invite.ts");
  if (existsSync(tsxBin)) {
    pass(tsxBin);
  } else {
    fail(`${tsxBin} is missing — the invite is spawned through it`);
  }
  if (existsSync(inviteScript)) {
    pass(inviteScript);
  } else {
    fail(`${inviteScript} is missing`);
  }
  const channelId = process.env.ADMINBOT_ONBOARDING_CHANNEL_ID?.trim();
  if (!channelId) {
    fail("ADMINBOT_ONBOARDING_CHANNEL_ID is unset — invites have no channel to go to");
  }
  try {
    const { getSlackWriteClient } = await import("../extensions/slack/api.js");
    const { resolveEmailAutomationSlackAccount } = await import("./adminbot-email-automation.ts");
    const slack = await resolveEmailAutomationSlackAccount();
    if (!slack.botToken) {
      fail("no Slack bot token resolved from the config");
    } else {
      const client = getSlackWriteClient(slack.botToken);
      const auth = (await client.apiCall("auth.test", {})) as {
        ok?: boolean;
        team?: string;
        user?: string;
        error?: string;
      };
      if (auth?.ok) {
        pass(`auth.test — bot ${auth.user} in ${auth.team}`);
      } else {
        fail(`auth.test refused: ${auth?.error ?? "unknown error"}`);
      }
      // Every project channel the plan names, resolved the way the invite script resolves it. A
      // typo here is worth catching now: at send time it stops the mail, one person at a time.
      if (auth?.ok && projectChannels.length > 0) {
        const byName = new Map<string, { id?: string; is_member?: boolean }>();
        let cursor: string | undefined;
        do {
          const page = (await client.apiCall("conversations.list", {
            limit: 1000,
            exclude_archived: true,
            types: "public_channel,private_channel",
            ...(cursor ? { cursor } : {}),
          })) as {
            channels?: { id?: string; name?: string; is_member?: boolean }[];
            response_metadata?: { next_cursor?: string };
          };
          for (const entry of page.channels ?? []) {
            if (entry.name) {
              byName.set(entry.name, { id: entry.id, is_member: entry.is_member });
            }
          }
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor);
        for (const channel of projectChannels) {
          const found = byName.get(channel.replace(/^#/u, "").trim());
          if (found?.id) {
            pass(`${channel} — ${found.id}${found.is_member ? "" : " (bot is NOT a member)"}`);
          } else {
            fail(`${channel} — no channel this bot can see; the send would stop here`);
          }
        }
      }
      if (channelId && auth?.ok) {
        const info = (await client.apiCall("conversations.info", { channel: channelId })) as {
          ok?: boolean;
          channel?: { name?: string; is_member?: boolean };
          error?: string;
        };
        if (info?.ok) {
          pass(
            `conversations.info — #${info.channel?.name} (bot is ${info.channel?.is_member ? "a member" : "NOT a member"})`,
          );
        } else {
          fail(`conversations.info on ${channelId} refused: ${info?.error ?? "unknown error"}`);
        }
      }
    }
  } catch (error) {
    fail(`Slack check could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log("");

  console.log("Not exercised by this batch");
  if (needsDrive === 0) {
    console.log("  - Drive workspace provisioning: no send names a folder");
  }
  console.log("  - DCS Slack-access form: only the full-member guide files it");
  console.log("  - Lab calendar invites: wired to account approval, not to the guide send");
  if (projectChannels.length === 0) {
    console.log("  - Project-channel (#proj-…) invites: none named in this plan");
  }
  console.log("  - Roster/spreadsheet rows: the send writes an audit row, not a member record");
  console.log("");
  return ok;
}

// Every ADMINBOT_* token the copy can resolve, so an unset one is reported here rather than
// discovered as a placeholder in someone's inbox.
const DEPLOYMENT_VARS = [
  "ADMINBOT_SLACK_INVITE_URL",
  "ADMINBOT_CONTACT_EMAILS",
  "ADMINBOT_BOT_EMAIL",
  "ADMINBOT_PI_LINKEDIN_URL",
  "ADMINBOT_LAB_X_URL",
  "ADMINBOT_DASHBOARD_URL",
  "ADMINBOT_EMAIL_FORMAT_EXAMPLE",
  "ADMINBOT_ONBOARDING_CHANNEL_ID",
] as const;

function reportEnvironment(): void {
  console.log("Deployment configuration on this host");
  for (const name of DEPLOYMENT_VARS) {
    const raw = process.env[name]?.trim();
    const state = !raw
      ? "UNSET"
      : raw.startsWith("REPLACE_ME")
        ? "UNSET (still the example placeholder)"
        : "set";
    console.log(`  ${name}: ${state}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const { plan: planPath, preflight: wantPreflight } = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlannedSend[];

  reportEnvironment();
  if (wantPreflight && !(await preflight(plan))) {
    // Keep going: the composed mail is still worth reading, and the failures above say what to fix.
    process.exitCode = 1;
  }

  let failures = 0;
  for (const [index, planned] of plan.entries()) {
    const { subgroup, note, ...request } = planned;
    const performed: string[] = [];
    const send = createAdminBotOnboardingSender({
      provisionDriveWorkspace: async ({ folderName }) => {
        performed.push(`Drive: copy the workspace prototype to "${folderName}" and share it`);
        return { folderId: "dry-run", link: "https://drive.google.com/drive/folders/DRY-RUN" };
      },
      inviteToSlackConnect: async ({ email, channelId }) => {
        performed.push(`Slack: Connect invite to ${email} for channel ${channelId}`);
        return { url: "https://join.slack.com/share/DRY-RUN" };
      },
      submitDcsForm: async ({ firstName, lastName, email }) => {
        performed.push(`DCS: file the Slack-access form for ${firstName} ${lastName} <${email}>`);
      },
      // The one call that would actually reach a person. It records instead.
      sendEmail: async ({ to, subject }) => {
        performed.push(`Gmail: send "${subject}" to ${to}`);
      },
      headProfessorWhatsapp: () => process.env.ADMINBOT_HEAD_PROFESSOR_WHATSAPP?.trim(),
    });

    console.log("=".repeat(78));
    console.log(
      `[${index + 1}/${plan.length}] ${request.name} <${request.email}> — ${request.template_id}`,
    );
    if (note) {
      console.log(`note: ${note}`);
    }
    console.log("");

    const result = await send(request);
    if (!result.ok) {
      failures += 1;
      console.log(`REFUSED (${result.error.status}): ${result.error.message}`);
      if (result.error.missing?.length) {
        console.log(`  missing: ${result.error.missing.join(", ")}`);
      }
      console.log("");
      continue;
    }

    console.log(`Subject: ${result.payload.subject}`);
    console.log("-".repeat(78));
    console.log(result.payload.body);
    console.log("-".repeat(78));
    console.log(`html alternative: ${result.payload.body_html ? "rendered" : "none"}`);
    console.log("");
    console.log("Would perform, in this order:");
    for (const step of performed) {
      console.log(`  - ${step}`);
    }
    console.log(
      `  - Audit: onboarding.guide_sent (template ${result.payload.template_id}, recipient ${request.email})`,
    );
    if (result.payload.dcs_form) {
      console.log(
        `  - Audit: ${result.payload.dcs_form.submitted ? "auth.dcs_form_submitted" : "auth.dcs_form_failed"}`,
      );
    }
    if (!performed.some((step) => step.startsWith("Drive:"))) {
      console.log(
        `  - (no Drive folder: this copy names none; a send that did would create "${driveWorkspaceFolderName(request.name)}")`,
      );
    }
    if (subgroup) {
      console.log("");
      console.log(`Access this subgroup (${subgroup}) implies, per the matrix:`);
      for (const grant of collaboratorSubgroupAccess(subgroup)) {
        const marker = grant.cell === "yes" ? "" : ` [${grant.cell.replaceAll("_", " ")}]`;
        console.log(`  - ${grant.label}${marker}`);
      }
      console.log(
        "  (the matrix is what an admin works through; only the Drive folder and the Slack",
      );
      console.log("   Connect invite above are automated by the send itself)");
    }
    console.log("");
  }

  console.log("=".repeat(78));
  console.log(
    `Dry run complete: ${plan.length - failures}/${plan.length} would send, ${failures} refused. Nothing was sent.`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
