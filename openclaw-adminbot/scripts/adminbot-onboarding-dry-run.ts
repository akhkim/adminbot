// Rehearses an onboarding batch, and -- with --send --yes -- performs it.
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
// Add --preflight to check the live dependencies, --only "Yuen,Isabel" to work on a subset, and
// --send --yes to perform the batch for real. A real send writes no audit row -- only the route
// behind the tab does -- so pass --receipts <file> and keep it: it is the record that it happened.
//
// The plan file is a JSON array of sends and stays out of this repo: it carries names and
// addresses, and this repo is public.
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveGogExecutable } from "../extensions/adminbot/src/connectors/gog.js";
import type { AdminBotExternalCollaboratorSubgroup } from "../extensions/adminbot/src/contracts/actions.js";
import { collaboratorSubgroupAccess } from "../extensions/adminbot/src/workflows/members/collaborator-subgroups.js";
import { findOnboardingTemplate } from "../extensions/adminbot/src/workflows/onboarding/emails.js";
import {
  createAdminBotOnboardingSender,
  gogEmailSender,
  type AdminBotOnboardingSendRequest,
} from "../extensions/adminbot/src/workflows/onboarding/guide-sender.js";
import { driveWorkspaceFolderName } from "../extensions/adminbot/src/workflows/onboarding/guide.js";

type PlannedSend = AdminBotOnboardingSendRequest & {
  /** Channels the send invites them to; carried on the request itself. */
  slack_project_channels?: readonly string[];
  /** The matrix row whose follow-up access this send implies, when the person is external. */
  subgroup?: AdminBotExternalCollaboratorSubgroup;
  /**
   * Which cohort of the plan file this came from ("direct_matching", "test_onboard_3", ...).
   *
   * Carried so --group can select one. The cohorts are sent on different days and under different
   * rules -- the applicants go out as a batch, the onboarding guides wait on a person reading
   * them -- and --only matches names, which the composed applicant rows do not have.
   */
  group?: string;
  /** Free-text reminder of why this send is shaped the way it is; printed, never sent. */
  note?: string;
};

export type Args = {
  plan: string;
  preflight: boolean;
  send: boolean;
  only: readonly string[];
  receipts?: string;
  noEmail: boolean;
  redirectTo?: string;
  groups: readonly string[];
};

export function parseArgs(argv: readonly string[]): Args {
  const valueOf = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const plan = valueOf("--plan");
  if (!plan) {
    throw new Error(
      "usage: adminbot-onboarding-dry-run.ts --plan <plan.json> [--preflight] [--group <cohorts>] [--only <names>] [--no-email] [--redirect-to <address>] [--send --yes] [--receipts <file>]",
    );
  }
  const send = argv.includes("--send");
  if (send && !argv.includes("--yes")) {
    // --send delivers real mail and mints real invites. Making the second flag mandatory means no
    // one arrives here by editing a dry-run command and pressing up-enter.
    throw new Error("--send also requires --yes: this delivers real email and real Slack invites");
  }
  const noEmail = argv.includes("--no-email");
  const redirectTo = valueOf("--redirect-to")?.trim();
  if (noEmail && redirectTo) {
    // One says "send nothing", the other says "send it here". A run that accepted both would have
    // to pick, and whichever it picked would surprise somebody.
    throw new Error("--no-email and --redirect-to are mutually exclusive: pick one");
  }
  if (redirectTo && !redirectTo.includes("@")) {
    throw new Error(`--redirect-to needs an address, got "${redirectTo}"`);
  }
  return {
    plan,
    preflight: argv.includes("--preflight"),
    send,
    noEmail,
    ...(redirectTo ? { redirectTo } : {}),
    only: (valueOf("--only") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    groups: (valueOf("--group") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    ...(valueOf("--receipts") ? { receipts: valueOf("--receipts") as string } : {}),
  };
}

/**
 * Mints a real Slack Connect invite, the way the service does: out-of-process through tsx.
 *
 * Copied in shape from start-adminbot.mjs rather than imported, because that launcher is a .mjs
 * entry point rather than a module anything can pull a function out of. The contract is the
 * script's, not this file's: one JSON object in on stdin, one JSON line out.
 */
async function realSlackInviter(params: {
  email: string;
  channelId: string;
}): Promise<{ url: string }> {
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const script = path.join(REPO_ROOT, "scripts", "adminbot-slack-connect-invite.ts");
  // The request goes in on stdin, so this drives the callback form rather than the promisified
  // one: there is no writable stdin to hand a JSON body to after the promise has been made.
  const child = execFileCallback(tsxBin, [script], { cwd: REPO_ROOT, timeout: 5 * 60_000 });
  child.stdin?.end(JSON.stringify(params));
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => resolve({ stdout: out, stderr: `${err}\n${error.message}` }));
    child.on("close", () => resolve({ stdout: out, stderr: err }));
  });
  const line = stdout
    .trim()
    .split(/\r?\n/u)
    .findLast((entry) => entry.trim().length > 0);
  const payload = line
    ? (JSON.parse(line) as { ok?: boolean; url?: string; invite_id?: string; error?: string })
    : undefined;
  if (!payload?.ok) {
    // Everything stderr said, minus node's own trailer. Reporting only the last line meant the
    // reason was almost always replaced by "(Use `node --trace-warnings ...`)", which named the
    // one thing that was not the problem.
    const detail = stderr
      .trim()
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.startsWith("(Use `node --trace-warnings"))
      .slice(-5)
      .join(" | ");
    throw new Error(
      payload?.error ?? `the invite script returned no result: ${detail || "(no stderr)"}`,
    );
  }
  // An empty url with an invite id is a sent invitation, not a failure: Slack delivers it directly
  // when the address already has an account, which is every alumnus already in the workspace. The
  // script says so and the sender copes -- its copy becomes "check your inbox for the Slack
  // invitation" -- and this wrapper used to reject it on the way past, turning a delivered invite
  // into a 502 that stopped the mail.
  return { url: payload.url ?? "" };
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
  if (account) {
    pass(`GOG_ACCOUNT=${account}`);
    // The binary running proves nothing about its OAuth, which is the failure that actually
    // happens: tokens expire and get revoked, and the first thing to notice used to be a batch
    // dying on its first send. Same read-only call the service's own start gate makes.
    try {
      await execFile(
        gog,
        ["gmail", "labels", "list", "--account", account, "--json", "--no-input"],
        {
          timeout: 60_000,
        },
      );
      pass("gmail labels list — the token is live");
    } catch (error) {
      // gog reports the OAuth failure on stderr; the Error message alone is just "command failed",
      // which is the difference between a diagnosis and a shrug.
      const stderr = (error as { stderr?: string })?.stderr ?? "";
      const detail = `${error instanceof Error ? error.message : String(error)}\n${stderr}`;
      fail(
        detail.includes("invalid_grant") || detail.includes("expired or revoked")
          ? "the gog token is expired or revoked — run: scripts/aurora-adminbot-host.sh --user akim auth-gog"
          : `gog could not reach Gmail: ${(stderr.trim() || detail).split("\n").at(-1)}`,
      );
    }
  } else {
    console.log(
      "  note  GOG_ACCOUNT unset — gog sends from its own default account, unverifiable here",
    );
  }
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

/**
 * Reads either shape of plan file.
 *
 * The tool was written for a flat array of send requests. The composed-email files the lab
 * actually produces are grouped by cohort (`direct_matching`, `test_onboard_3`, ...) and carry the
 * rendered `subject`/`body` plus the per-recipient `cc` and `reply_to`, which map onto the
 * overrides the sender already understands. Accepting both means the file somebody reviewed is the
 * file that gets sent, rather than a hand-conversion of it that can differ.
 *
 * An entry with a non-empty `needs` is dropped rather than sent. `needs` is the composer's record
 * of a question it could not answer -- which of two applicants a document belongs to, most
 * recently -- and a mail that goes out while that is open is a mail to the wrong person.
 */
export function loadPlan(planPath: string): {
  sends: PlannedSend[];
  skipped: Array<{ name: string; email: string; reason: string }>;
} {
  const raw = JSON.parse(readFileSync(planPath, "utf8")) as unknown;
  if (Array.isArray(raw)) {
    return { sends: raw as PlannedSend[], skipped: [] };
  }
  const groups = raw as Record<string, unknown>;
  const sends: PlannedSend[] = [];
  const skipped: Array<{ name: string; email: string; reason: string }> = [];
  for (const [group, value] of Object.entries(groups)) {
    if (!Array.isArray(value) || group === "skipped") {
      continue;
    }
    for (const entry of value as Array<Record<string, unknown>>) {
      const email = typeof entry.email === "string" ? entry.email : "";
      const templateId = typeof entry.template_id === "string" ? entry.template_id : "";
      if (!email || !templateId) {
        continue;
      }
      const name = typeof entry.name === "string" && entry.name ? entry.name : email;
      const needs = Array.isArray(entry.needs) ? entry.needs.filter(Boolean) : [];
      if (needs.length > 0) {
        skipped.push({ name, email, reason: String(needs[0]) });
        continue;
      }
      sends.push({
        group,
        template_id: templateId,
        name,
        email,
        ...(entry.values && typeof entry.values === "object"
          ? { values: entry.values as Record<string, string> }
          : {}),
        ...(typeof entry.subject === "string" && entry.subject
          ? { subject_override: entry.subject }
          : {}),
        ...(typeof entry.body === "string" && entry.body ? { body_override: entry.body } : {}),
        ...(Array.isArray(entry.cc) && entry.cc.length ? { cc: entry.cc as string[] } : {}),
        ...(typeof entry.reply_to === "string" && entry.reply_to
          ? { reply_to: entry.reply_to }
          : {}),
        ...(Array.isArray(entry.slack_project_channels)
          ? { slack_project_channels: entry.slack_project_channels as string[] }
          : {}),
      });
    }
  }
  return { sends, skipped };
}

const gogSendEmail = gogEmailSender();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const planPath = args.plan;
  const { sends: all, skipped } = loadPlan(planPath);
  for (const entry of skipped) {
    console.log(`skipping ${entry.name} <${entry.email}> — unresolved needs: ${entry.reason}`);
  }
  if (skipped.length > 0) {
    console.log("");
  }
  const byGroup =
    args.groups.length === 0
      ? all
      : all.filter((entry) => entry.group && args.groups.includes(entry.group));
  if (byGroup.length === 0 && args.groups.length > 0) {
    const available = [...new Set(all.map((entry) => entry.group).filter(Boolean))];
    throw new Error(
      `--group matched nothing in ${planPath}; it has: ${available.join(", ") || "(no groups: this is a flat plan)"}`,
    );
  }
  const plan =
    args.only.length === 0
      ? byGroup
      : byGroup.filter((entry) =>
          args.only.some((needle) => entry.name.toLowerCase().includes(needle.toLowerCase())),
        );
  if (plan.length === 0) {
    throw new Error(`--only matched nothing in ${planPath}`);
  }
  if (args.groups.length > 0) {
    console.log(`cohort: ${args.groups.join(", ")} — ${plan.length} of ${all.length} send(s)`);
    console.log("");
  }
  if (args.send) {
    if (args.noEmail) {
      console.log(
        `PROVISIONING FOR REAL, SENDING NO EMAIL: ${plan.length} recipient(s). Slack invites are minted; the mail is not sent.`,
      );
    } else if (args.redirectTo) {
      console.log(
        `REDIRECTED SEND: ${plan.length} email(s) all going to ${args.redirectTo}, cc suppressed. No Slack invite is minted — this run is for reading the copy.`,
      );
    } else {
      console.log(`SENDING FOR REAL: ${plan.length} email(s), plus every invite they imply.`);
    }
    console.log("");
  }

  reportEnvironment();
  if (args.preflight && !(await preflight(plan))) {
    // Keep going: the composed mail is still worth reading, and the failures above say what to fix.
    process.exitCode = 1;
  }

  let failures = 0;
  // A record of what happened, since a CLI send writes no audit row -- only the route behind the
  // tab does. Keep the file: it is the only evidence this batch went out.
  const receipts: Record<string, unknown>[] = [];
  for (const [index, planned] of plan.entries()) {
    const { subgroup, note, group: _group, ...request } = planned;
    const performed: string[] = [];
    // Under --send the recorders are replaced one for one by the real thing: the default
    // `sendEmail` (gog), and the same out-of-process invite script the service spawns. Everything
    // else about the run -- the composer, the checks, the order -- is identical either way.
    const send = createAdminBotOnboardingSender({
      provisionDriveWorkspace: async ({ folderName, includeContents }) => {
        performed.push(
          includeContents
            ? `Drive: copy the workspace prototype to "${folderName}" and share it`
            : `Drive: create an empty "${folderName}" and share it (not a full member)`,
        );
        if (args.send) {
          throw new Error("Drive provisioning is not wired into this script; use the tab instead");
        }
        return { folderId: "dry-run", link: "https://drive.google.com/drive/folders/DRY-RUN" };
      },
      inviteToSlackConnect: async ({ email, channelId }) => {
        // Not under --redirect-to. That run exists so somebody can read the copy; minting a real
        // invite to the real person would make a review step outward-facing, and the full send
        // afterwards would mint them a second one.
        if (args.send && !args.redirectTo) {
          const invite = await realSlackInviter({ email, channelId });
          performed.push(`Slack: invited ${email} to ${channelId}`);
          return invite;
        }
        performed.push(`Slack: Connect invite to ${email} for channel ${channelId}`);
        return { url: "https://join.slack.com/share/DRY-RUN" };
      },
      submitDcsForm: async ({ firstName, lastName, email }) => {
        performed.push(`DCS: file the Slack-access form for ${firstName} ${lastName} <${email}>`);
        if (args.send) {
          throw new Error("the DCS form is not wired into this script; use the tab instead");
        }
      },
      ...(args.send && !args.noEmail
        ? {
            // Wraps the real sender only to record it: without this the transcript of a live run
            // listed audits and invites and never said an email had gone out.
            sendEmail: async (params: {
              to: string;
              subject: string;
              body: string;
              body_html?: string;
              cc?: readonly string[];
              reply_to?: string;
            }) => {
              // A redirected run is a rehearsal that goes through the real sender, so the reviewer
              // reads exactly what the recipient would. The cc goes with the address: a preview
              // must not put a project lead on a thread that is not really theirs yet.
              const to = args.redirectTo ?? params.to;
              const { cc: _cc, ...rest } = params;
              await gogSendEmail(args.redirectTo ? { ...rest, to } : params);
              performed.push(
                args.redirectTo
                  ? `Gmail: SENT "${params.subject}" to ${to} (REDIRECTED from ${params.to}; cc suppressed)`
                  : `Gmail: SENT "${params.subject}" to ${to}`,
              );
            },
          }
        : args.send && args.noEmail
          ? {
              // --no-email: provisioning is real, the mail is not. For a batch whose Slack invites
              // should land now and whose copy is still being read.
              sendEmail: async ({ to, subject }: { to: string; subject: string }) => {
                performed.push(`Gmail: SKIPPED "${subject}" to ${to} (--no-email)`);
              },
            }
          : {
            // The one call that would actually reach a person. It records instead.
            //
            // The cc and the Reply-To are printed because they are the half of a send a reviewer
            // cannot see in the body: these mails tell the applicant "your contact is the lead
            // cc'ed", and whether that is true of the actual message is only visible here.
            sendEmail: async ({
              to,
              subject,
              cc,
              reply_to: replyTo,
            }: {
              to: string;
              subject: string;
              cc?: readonly string[];
              reply_to?: string;
            }) => {
              const extra = [
                cc?.length ? `cc ${cc.join(", ")}` : "",
                replyTo ? `reply-to ${replyTo}` : "",
              ].filter(Boolean);
              performed.push(
                `Gmail: send "${subject}" to ${to}${extra.length ? ` (${extra.join("; ")})` : ""}`,
              );
            },
          }),
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

    // Nothing a single recipient can do should end the batch: an unexpected throw becomes that
    // entry's failure, and the remaining sends still get their turn.
    let result: Awaited<ReturnType<typeof send>>;
    try {
      result = await send(request);
    } catch (error) {
      result = {
        ok: false,
        error: { status: 500, message: error instanceof Error ? error.message : String(error) },
      };
    }
    receipts.push({
      name: request.name,
      email: request.email,
      template_id: request.template_id,
      ...(result.ok
        ? { sent: result.payload.sent, subject: result.payload.subject }
        : { sent: false, error: `${result.error.status}: ${result.error.message}` }),
      at: new Date().toISOString(),
    });
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
    console.log(args.send ? "Performed, in this order:" : "Would perform, in this order:");
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

  if (args.receipts) {
    writeFileSync(args.receipts, `${JSON.stringify(receipts, null, 2)}\n`);
    console.log(`Receipts written to ${args.receipts}`);
  }
  console.log("=".repeat(78));
  console.log(
    args.send
      ? `Sent ${plan.length - failures}/${plan.length}; ${failures} refused. This was NOT a dry run.`
      : `Dry run complete: ${plan.length - failures}/${plan.length} would send, ${failures} refused. Nothing was sent.`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

// Guarded so the pure parts above can be imported by a test without the module performing a run.
// Same shape as scripts/adminbot-email-automation.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
