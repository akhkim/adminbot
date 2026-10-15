// Mounted layout check for the browser settings that grow text past what the CSS was laid out
// for: Chrome's minimum font size, 400% page zoom, a 320px window and the WCAG 1.4.12
// text-spacing overrides, alone and all at once.
//
// The minimum font size is set the way a reader sets it, through the browser profile. It raises
// rendered text without changing `rem`/`em` lengths, so a box sized in rem stays put while the text
// in it grows -- which is exactly how the deadline countdowns ended up on top of venue names.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../../test-helpers/control-ui-e2e.ts";
import { collectTextLayoutProblems } from "../../../test-helpers/text-layout-problems.ts";
import { DEADLINE_VENUES } from "../data/deadlines.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeLayout = canRunPlaywrightChromium(executablePath) ? describe : describe.skip;

const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const aoe = (offsetDays: number) =>
  new Date(NOW.getTime() + offsetDays * DAY).toISOString().slice(0, 19).replace("T", " ");

// Synthetic catalogue: the bundled venues re-dated around NOW so every view has upcoming rows.
const deadlines = DEADLINE_VENUES.slice(0, 40).map((venue, index) => ({
  ...venue,
  deadline_aoe: aoe(index * 3 + 0.3),
  notification_aoe: venue.notification_aoe ? aoe(index * 3 + 60) : venue.notification_aoe,
}));

const member = (id: string, name: string, role: string, privilege = "member") => ({
  id,
  name,
  email: `${id}@example.test`,
  privilege_level: privilege,
  role,
  status: "active",
  location: "Toronto",
  timezone: "America/Toronto",
  affiliation: "Example Research Lab",
  research_topics: ["Document understanding", "Evaluation methodology"],
  hours_per_week: 40,
  access: [],
  created_at: "2026-01-05T15:00:00.000Z",
  updated_at: "2026-09-01T15:00:00.000Z",
});
const self = member("layout-admin", "Alice Example", "Lab Manager", "admin");
const members = [
  self,
  member("layout-long", "Maximiliane Konstantinopoulou-Vandersteen", "Postdoctoral Researcher"),
  member("layout-short", "Bo Li", "PhD Student"),
  member("layout-visitor", "Erin Example", "Visiting Researcher"),
];
const paper = (id: string, title: string, step: string) => ({
  id,
  title,
  authors: ["Alice Example", "Maximiliane Konstantinopoulou-Vandersteen"],
  author_links: [{ name: "Alice Example", member_id: self.id }],
  current_step: step,
  first_author_member_id: self.id,
  venue: "Example Conference on Document Intelligence",
  deadline: aoe(20).slice(0, 10),
  created_at: "2026-05-01T15:00:00.000Z",
  updated_at: "2026-09-01T15:00:00.000Z",
});
const papers = [
  paper("layout-p1", "Robust layout analysis for scanned conference proceedings", "overleaf_writing"),
  paper("layout-p2", "Short", "submission"),
];

// Every AdminBot service read the four pages make, answered from the fixtures above.
const responses: Record<string, unknown> = {
  "/auth/session": { member: self, expires_at: aoe(7).replace(" ", "T") + "Z" },
  "/deadlines": { items: deadlines },
  "/lab/members": { members, total: members.length, limit: 50, offset: 0 },
  "/lab/members/self": { member: self },
  "/lab/members/requests": { requests: [] },
  "/lab/meetings": { meetings: [] },
  "/papers": { papers },
  "/papers/slot-overview": { papers: [] },
  "/papers/nudges": { nudges: [] },
  "/papers/conference-rosters": { conferences: [] },
  "/my/projects": { projects: [] },
  "/notifications": { notifications: [] },
  "/proposals/pending": { proposals: [] },
  "/member-map": { mode: "full", places: [] },
  "/lab-sharing/status": { status: null, history: [], can_manage: true },
  "/travel/sharing": { sharing: { enabled: false } },
  "/automation/email/review": { reviews: [], recent_resolutions: [], paperflow_candidates: [] },
  "/settings": { paper_escalation_business_days: 3, meeting_minimum_minutes: 10 },
  "/sensitive-info": { markdown: "" },
};

function answerService(route: Route) {
  const url = new URL(route.request().url());
  if (url.pathname === "/lab/members" && url.searchParams.get("view") === "summary") {
    return route.fulfill({ json: { members, self } });
  }
  if (url.pathname.startsWith("/member-drafts/")) {
    return route.fulfill({ json: { draft: null } });
  }
  const body = responses[url.pathname];
  return body
    ? route.fulfill({ json: body })
    : route.fulfill({ status: 404, json: { error: "not in layout fixture" } });
}

const TEXT_SPACING =
  "*{line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}" +
  "p{margin-bottom:2em!important}";

type Condition = { name: string; minimumFontSize: number; width: number; height: number; spacing: boolean };
// 400% zoom of a 1280x800 window lays out exactly like a 320x200 CSS-pixel viewport.
const conditions: Condition[] = [
  { name: "min font 24 at 1440", minimumFontSize: 24, width: 1440, height: 900, spacing: false },
  { name: "min font 24 at 390", minimumFontSize: 24, width: 390, height: 900, spacing: false },
  { name: "400% zoom", minimumFontSize: 0, width: 320, height: 200, spacing: false },
  { name: "320px with text spacing", minimumFontSize: 0, width: 320, height: 900, spacing: true },
  { name: "all at once", minimumFontSize: 24, width: 320, height: 200, spacing: true },
];

const pages: Array<{ name: string; path: string; ready: string; prepare?: (page: Page) => Promise<void> }> = [
  { name: "dashboard", path: "dashboard", ready: ".dashboard__next-deadline" },
  {
    name: "deadlines",
    path: "deadlines",
    ready: ".deadline-group__summary",
    // Open the first groups so the rows -- where the countdown sits beside the venue -- are drawn.
    prepare: async (page) => {
      const summaries = page.locator(".deadline-group__summary");
      const count = Math.min(3, await summaries.count());
      for (let index = 0; index < count; index++) {
        await summaries.nth(index).evaluate((el: HTMLElement) => el.click());
      }
    },
  },
  { name: "members", path: "members", ready: "main.content table" },
  { name: "papers", path: "papers", ready: ".adminbot-metrics" },
];

// Out of scope here: the member map lays its own labels out (tracked separately), and the
// floating feedback button and tooltip sit above the page on purpose.
const IGNORE = ["#adminbot-dev-account-picker", "#control-ui-floating-tooltip", ".fb__open", "[class*='member-map']"];

describeLayout("text scaling layout", () => {
  let server: ControlUiE2eServer;
  const profiles: string[] = [];

  beforeAll(async () => {
    server = await startControlUiE2eServer();
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    for (const dir of profiles) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function openProfile(minimumFontSize: number): Promise<BrowserContext> {
    const dir = mkdtempSync(path.join(tmpdir(), "adminbot-text-scaling-"));
    profiles.push(dir);
    mkdirSync(path.join(dir, "Default"));
    writeFileSync(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({
        webkit: {
          webprefs: {
            minimum_font_size: minimumFontSize,
            minimum_logical_font_size: minimumFontSize || 6,
          },
        },
      }),
    );
    return chromium.launchPersistentContext(dir, { executablePath, headless: true });
  }

  for (const condition of conditions) {
    it(`keeps text apart and visible: ${condition.name}`, async () => {
      const context = await openProfile(condition.minimumFontSize);
      try {
        const page = await context.newPage();
        await page.setViewportSize({ width: condition.width, height: condition.height });
        await page.clock.setFixedTime(NOW);
        await installMockGateway(page);
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw.adminbot.session.v1",
            JSON.stringify({ sessionToken: "layout-fixture", expiresAt: "2099-01-01T00:00:00Z" }),
          );
        });
        const base = new URL(server.baseUrl);
        await page.route(
          (url) => url.origin !== base.origin,
          (route) => answerService(route),
        );

        const failures: string[] = [];
        for (const target of pages) {
          await page.goto(`${server.baseUrl}${target.path}`);
          await page.locator(target.ready).first().waitFor({ timeout: 15_000 });
          await target.prepare?.(page);
          if (condition.spacing) {
            await page.addStyleTag({ content: TEXT_SPACING });
          }
          await page.mouse.move(0, 0);
          // The checks only look at what is on screen, so walk the scrolling content area.
          const height = await page.evaluate(
            () => document.querySelector("main.content")?.scrollHeight ?? 0,
          );
          const seen = new Set<string>();
          for (let top = 0; top < Math.min(height, 6000); top += Math.max(150, condition.height - 60)) {
            await page.evaluate((y) => {
              const main = document.querySelector("main.content");
              if (main) {
                main.scrollTop = y;
              }
            }, top);
            const found = await page.evaluate(collectTextLayoutProblems, IGNORE);
            for (const problem of [...found.overlaps, ...found.clipped, ...found.escaped]) {
              seen.add(`${target.name}: ${problem}`);
            }
          }
          const pageOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (pageOverflow > 1) {
            seen.add(`${target.name}: page scrolls sideways by ${pageOverflow}px`);
          }
          failures.push(...seen);
        }
        expect(failures, condition.name).toEqual([]);
      } finally {
        await context.close();
      }
    }, 180_000);
  }
});
