#!/usr/bin/env node
// Boots the Control UI against a mocked Gateway and captures full-page Playwright
// screenshots of every major view, at every configured viewport, to a target directory.
//
// Usage:
//   node --import tsx scripts/ui-screenshots.mjs --out <dir> [--only <tab,tab>] [--viewport 1440x900]
//
// Requires `--import tsx` (or an equivalent TS loader) because it imports the Control UI's
// TypeScript sources directly, matching the repo's other TS-authored `.mjs` tooling.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { pathForTab, SETTINGS_TABS, TAB_GROUPS } from "../ui/src/ui/navigation.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOGIN_TARGET_ID = "login";

const DEFAULT_VIEWPORTS = [
  { height: 900, name: "1440x900", width: 1440 },
  { height: 812, name: "375x812", width: 375 },
];

// AdminBot tool responses reused verbatim from
// ui/src/ui/e2e/adminbot-navigation.e2e.test.ts so every AdminBot route renders
// realistic content instead of the "tools are not available" fallback panel.
const ADMIN_BOT_AGENT_SCENARIO = {
  assistantAgentId: "adminbot",
  assistantName: "AdminBot",
  defaultAgentId: "adminbot",
  sessionKey: "agent:adminbot:main",
};

function adminBotToolResponses() {
  return {
    cases: [
      {
        match: { name: "adminbot_list_pending_actions" },
        response: {
          ok: true,
          output: {
            proposals: [
              {
                id: "proposal-1",
                approval_requirement: {
                  approver_roles: ["admin"],
                  min_approvals: 1,
                  requires_approval: true,
                },
                approvals: [],
                created_at: "2026-06-10T12:00:00.000Z",
                payload_hash: "sha256:adminbot",
                risk_tier: "T2",
                status: "pending",
                summary: "Approve reimbursement packet",
                type: "reimbursement.prepare",
                updated_at: "2026-06-10T12:00:00.000Z",
              },
            ],
          },
          toolName: "adminbot_list_pending_actions",
        },
      },
      {
        match: { name: "adminbot_list_lab_members" },
        response: {
          ok: true,
          output: {
            members: [
              {
                access: [{ access: "edit", service: "slack" }],
                created_at: "2026-06-10T12:00:00.000Z",
                email: "maya@example.test",
                id: "member-1",
                name: "Maya Chen",
                notes:
                  "Imported from Jinesis Contact/Paper member CSV.\nLocation: Toronto\nResearch interests: Causal Inference and LLMs\nGitHub: maya-chen",
                privilege_level: "member",
                updated_at: "2026-06-10T12:00:00.000Z",
              },
            ],
          },
          toolName: "adminbot_list_lab_members",
        },
      },
      {
        match: { name: "adminbot_list_papers" },
        response: {
          ok: true,
          output: {
            papers: [
              {
                authors: ["Maya Chen"],
                created_at: "2026-06-10T12:00:00.000Z",
                current_step: "social_posts",
                artifacts: { conference: "NeurIPS 2026" },
                id: "paper-1",
                title: "Causal Lab Systems",
                timeline: {
                  current_step_index: 5,
                  progress_percent: 63,
                  total_estimated_business_days: 40,
                  items: [
                    {
                      color: "#5b8def",
                      dependency_group: "publish",
                      depends_on: [],
                      duration_business_days: 6,
                      label: "Social posts",
                      offset_end_business_day: 30,
                      offset_start_business_day: 24,
                      status: "current",
                      step: "social_posts",
                    },
                  ],
                },
                updated_at: "2026-06-10T12:00:00.000Z",
              },
            ],
          },
          toolName: "adminbot_list_papers",
        },
      },
      {
        match: { name: "adminbot_list_paper_nudges" },
        response: {
          ok: true,
          output: {
            nudges: [
              {
                message: "Please send the Twitter draft.",
                paper_id: "paper-1",
                recipients: ["Maya Chen"],
                step: "social_posts",
                title: "Causal Lab Systems",
                type: "author_nudge",
              },
            ],
          },
          toolName: "adminbot_list_paper_nudges",
        },
      },
      {
        match: { name: "adminbot_get_settings" },
        response: {
          ok: true,
          output: {
            default_privilege_level: "member",
            head_professor_member_id: "zhijing",
            paper_escalation_business_days: 3,
            updated_at: "2026-06-10T12:00:00.000Z",
          },
          toolName: "adminbot_get_settings",
        },
      },
      {
        match: { name: "adminbot_get_sensitive_info" },
        response: {
          ok: true,
          output: { markdown: "" },
          toolName: "adminbot_get_sensitive_info",
        },
      },
    ],
  };
}

function resolveAllTabs() {
  const tabs = [];
  for (const group of TAB_GROUPS) {
    if (group.label === "settings") {
      tabs.push(...SETTINGS_TABS);
      continue;
    }
    tabs.push(...group.tabs);
  }
  return tabs;
}

function scenarioForTab(tab) {
  if (tab.startsWith("adminbot")) {
    return {
      ...ADMIN_BOT_AGENT_SCENARIO,
      methodResponses: { "tools.invoke": adminBotToolResponses() },
    };
  }
  return {};
}

function parseArgs(argv) {
  const options = { only: null, out: null, viewports: DEFAULT_VIEWPORTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      options.out = argv[++i];
    } else if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
    } else if (arg === "--only") {
      options.only = argv[++i];
    } else if (arg.startsWith("--only=")) {
      options.only = arg.slice("--only=".length);
    } else if (arg === "--viewport") {
      options.viewports = [parseViewport(argv[++i])];
    } else if (arg.startsWith("--viewport=")) {
      options.viewports = [parseViewport(arg.slice("--viewport=".length))];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseViewport(raw) {
  const match = /^(\d+)x(\d+)$/.exec(String(raw ?? "").trim());
  if (!match) {
    throw new Error(`Invalid --viewport value: ${raw} (expected e.g. 1440x900)`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return { height, name: `${width}x${height}`, width };
}

function printHelp() {
  console.log(
    `Usage: node --import tsx scripts/ui-screenshots.mjs --out <dir> [--only <tab,tab>] [--viewport 1440x900]

Captures full-page screenshots of the Control UI against a mocked Gateway:
  - the unauthenticated sign-in screen
  - every route in ui/src/ui/navigation.ts (TAB_PATHS), including all AdminBot routes

Options:
  --out <dir>         Output directory (required). Screenshots are written to
                       <dir>/<viewport>/<tab>.png
  --only <tab,tab>    Restrict capture to a comma-separated list of tab names
                       (as used in ui/src/ui/navigation.ts) and/or "login"
  --viewport WxH      Capture only this viewport instead of the default two
                       (1440x900 desktop, 375x812 mobile)
`,
  );
}

const DISABLE_ANIMATIONS_CSS = "* { animation: none !important; transition: none !important; }";

async function captureLogin(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator(".login-gate").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
}

async function captureTab(page, baseUrl, tab) {
  await installMockGateway(page, scenarioForTab(tab));
  const routePath = pathForTab(tab);
  await page.goto(new URL(routePath.slice(1), baseUrl).toString(), { waitUntil: "networkidle" });
  await page.locator("main.content").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
  // Let the mocked Gateway's queued responses (chat.startup, tools.invoke, ...) settle
  // and any resulting re-render finish before shooting.
  await page.waitForLoadState("networkidle");
}

async function shootTarget({ baseUrl, browser, outDir, target, viewport }) {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: viewport.height, width: viewport.width },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    if (target === LOGIN_TARGET_ID) {
      await captureLogin(page, baseUrl);
    } else {
      await captureTab(page, baseUrl, target);
    }
    const destDir = path.join(outDir, viewport.name);
    await mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, `${target}.png`);
    await page.screenshot({ fullPage: true, path: destPath });
    return { destPath, status: "captured", target, viewport: viewport.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = pageErrors.length > 0 ? `${message} (page error: ${pageErrors[0]})` : message;
    return { reason, status: "failed", target, viewport: viewport.name };
  } finally {
    await context.close();
  }
}

function printSummary(results) {
  const rows = results.map((result) => ({
    reason: result.reason ?? "",
    status: result.status,
    target: result.target,
    viewport: result.viewport,
  }));
  const captured = rows.filter((row) => row.status === "captured");
  const failed = rows.filter((row) => row.status === "failed");
  const skipped = rows.filter((row) => row.status === "skipped");

  console.log("\n=== UI screenshot summary ===");
  console.table(rows);
  console.log(
    `Captured: ${captured.length}  Failed: ${failed.length}  Skipped: ${skipped.length}  Total: ${rows.length}`,
  );
  if (failed.length > 0) {
    console.log("\nFailed routes:");
    for (const row of failed) {
      console.log(`  - [${row.viewport}] ${row.target}: ${row.reason}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.out) {
    printHelp();
    throw new Error("--out <dir> is required");
  }
  const outDir = path.resolve(repoRoot, options.out);
  await mkdir(outDir, { recursive: true });

  const allTabs = resolveAllTabs();
  const allTargets = [LOGIN_TARGET_ID, ...allTabs];
  let targets = allTargets;
  if (options.only) {
    const requested = options.only
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const unknown = requested.filter((value) => !allTargets.includes(value));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown --only target(s): ${unknown.join(", ")}. Known targets: ${allTargets.join(", ")}`,
      );
    }
    targets = requested;
  }

  const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    throw new Error(
      `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\` or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.`,
    );
  }

  console.log(`Starting Control UI dev server...`);
  const server = await startControlUiE2eServer();
  console.log(`Control UI dev server listening at ${server.baseUrl}`);
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });

  const results = [];
  try {
    for (const viewport of options.viewports) {
      for (const target of targets) {
        console.log(`[${viewport.name}] capturing ${target}...`);
        const result = await shootTarget({
          baseUrl: server.baseUrl,
          browser,
          outDir,
          target,
          viewport,
        });
        results.push(result);
        if (result.status === "failed") {
          console.error(`[${viewport.name}] ${target} FAILED: ${result.reason}`);
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  printSummary(results);
  if (results.every((result) => result.status !== "captured")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
