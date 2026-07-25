// Control UI tests cover AdminBot navigation with a mocked Gateway.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

const adminBotAgentScenario = {
  assistantAgentId: "adminbot",
  assistantName: "AdminBot",
  defaultAgentId: "adminbot",
  sessionKey: "agent:adminbot:main",
};

function requestToolName(params: unknown): string | null {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (((params as { name?: unknown }).name as string | undefined) ?? null)
    : null;
}

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

describeControlUiE2e("AdminBot Control UI navigation", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("routes each AdminBot sidebar tab to a focused panel", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      ...adminBotAgentScenario,
      methodResponses: { "tools.invoke": adminBotToolResponses() },
    });

    try {
      await page.goto(`${server.baseUrl}adminbot`);
      await page.getByText("Approve reimbursement packet").waitFor({ timeout: 10_000 });

      await page.locator('a[href="/adminbot/settings"]').click();
      await page.waitForURL("**/adminbot/settings");
      await page.getByText("Paper escalation business days").waitFor();

      await page.getByRole("link", { name: "Lab Members" }).click();
      await page.waitForURL("**/adminbot/members");
      await page
        .locator(".adminbot-editor-card--member summary")
        .filter({ hasText: "Maya Chen" })
        .waitFor();
      const memberCard = page.locator(".adminbot-editor-card--member").filter({
        hasText: "Maya Chen",
      });
      expect(await memberCard.locator('input[name="location"]').inputValue()).toBe("Toronto");
      expect(await memberCard.locator('input[name="researchInterests"]').inputValue()).toBe(
        "Causal Inference and LLMs",
      );

      await page.getByRole("link", { name: "Active Papers" }).click();
      await page.waitForURL("**/adminbot/papers");
      await page.locator(".adminbot-paper-overview").getByText("Causal Lab Systems").waitFor();
      await page.getByText("Paper timeline overview").waitFor();
      expect(await page.locator(".adminbot-paper-gantt__row").count()).toBe(1);
      await page.locator('select[name="conference"]').selectOption("NeurIPS 2026");
      await page.locator('select[name="progress"]').selectOption("early");
      expect(await page.locator(".adminbot-paper-gantt__row:visible").count()).toBe(0);
      await page.locator('select[name="progress"]').selectOption("");
      expect(await page.locator(".adminbot-paper-gantt__row:visible").count()).toBe(1);

      await page.getByRole("link", { name: "Paper Nudges" }).click();
      await page.waitForURL("**/adminbot/nudges");
      await page.getByText("Please send the Twitter draft.").waitFor();

      const toolRequests = await gateway.getRequests("tools.invoke");
      expect(
        toolRequests.some((request) => requestToolName(request.params) === "adminbot_get_settings"),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("shows setup guidance when AdminBot tools are unavailable", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      ...adminBotAgentScenario,
      methodResponses: {
        "tools.invoke": {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Tool not available: adminbot_list_pending_actions",
          },
          toolName: "adminbot_list_pending_actions",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}adminbot`);
      await page
        .getByText("AdminBot tools are not available in this Gateway.")
        .waitFor({ timeout: 10_000 });
    } finally {
      await context.close();
    }
  });
});
