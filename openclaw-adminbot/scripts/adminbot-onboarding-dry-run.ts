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
//   cd ~/services/openclaw-adminbot/current
//   set -a; . ~/.config/jinesis-adminbot/adminbot.env; set +a
//   node --import tsx scripts/adminbot-onboarding-dry-run.ts --plan ~/onboarding-plan.json
//
// The plan file is a JSON array of sends and stays out of this repo: it carries names and
// addresses, and this repo is public.
import { readFileSync } from "node:fs";
import type { AdminBotExternalCollaboratorSubgroup } from "../extensions/adminbot/src/contracts/actions.js";
import { collaboratorSubgroupAccess } from "../extensions/adminbot/src/workflows/members/collaborator-subgroups.js";
import {
  createAdminBotOnboardingSender,
  type AdminBotOnboardingSendRequest,
} from "../extensions/adminbot/src/workflows/onboarding/guide-sender.js";
import { driveWorkspaceFolderName } from "../extensions/adminbot/src/workflows/onboarding/guide.js";

type PlannedSend = AdminBotOnboardingSendRequest & {
  /** The matrix row whose follow-up access this send implies, when the person is external. */
  subgroup?: AdminBotExternalCollaboratorSubgroup;
  /** Free-text reminder of why this send is shaped the way it is; printed, never sent. */
  note?: string;
};

function parseArgs(argv: readonly string[]): { plan: string } {
  const planFlag = argv.indexOf("--plan");
  if (planFlag === -1 || !argv[planFlag + 1]) {
    throw new Error("usage: adminbot-onboarding-dry-run.ts --plan <plan.json>");
  }
  return { plan: argv[planFlag + 1] as string };
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
  const { plan: planPath } = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlannedSend[];

  reportEnvironment();

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
