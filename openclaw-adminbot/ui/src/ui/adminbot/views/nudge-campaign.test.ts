// The nudge campaign preview/confirm button and the campaigns listing. Synthetic members only; the
// server is a stubbed fetch, so nothing is sent anywhere.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotNudgeCampaign, AdminBotNudgeCampaigns } from "./nudge-campaign.ts";
import {
  cooldownText,
  parseNudgeCampaignListing,
  parseNudgeCampaignResult,
  skipSummary,
} from "./nudge-campaign.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const ROUTE = "/members/example-nudge";

const preview = {
  campaign: "example_campaign",
  dry_run: true,
  count: 2,
  skipped: { nudges_off: 1, already_sent: 3, hidden: 0 },
  samples: [
    { member_id: "m1", name: "Person One", message: "Hi Person 👋 Quick one for the lab map" },
    { member_id: "m2", name: "Person Two", message: "Hi Person 👋 where are you based" },
  ],
};

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

async function mount(): Promise<AdminBotNudgeCampaign> {
  await import("./nudge-campaign.ts");
  const el = document.createElement("adminbot-nudge-campaign") as AdminBotNudgeCampaign;
  el.baseUrl = "http://adminbot.test/";
  el.sessionToken = "synthetic-session";
  el.route = ROUTE;
  el.label = "Ask members on Slack";
  document.body.append(el);
  await el.updateComplete;
  return el;
}

function bodyOf(call: unknown[]): unknown {
  return JSON.parse((call[1] as { body: string }).body);
}

describe("parsing", () => {
  it("keeps a well-formed result, drops zero skips, and refuses anything else", () => {
    expect(parseNudgeCampaignResult(preview)?.skipped).toEqual({ nudges_off: 1, already_sent: 3 });
    expect(parseNudgeCampaignResult({ error: { message: "forbidden" } })).toBeNull();
    expect(parseNudgeCampaignResult(null)).toBeNull();
  });

  it("words skips and cooldowns plainly", () => {
    expect(skipSummary({ nudges_off: 1, something_new: 2 })).toBe(
      "1 nudges turned off · 2 something new",
    );
    expect(cooldownText(null)).toBe("once per member");
    expect(cooldownText(0)).toBe("every run");
    expect(cooldownText(14)).toBe("at most every 14d");
  });

  it("reads the campaigns listing", () => {
    expect(
      parseNudgeCampaignListing({
        campaigns: [{ key: "k", label: "L", route: "/r", members_reached: 1 }, { key: 1 }],
      }),
    ).toHaveLength(1);
    expect(parseNudgeCampaignListing({})).toBeNull();
  });
});

describe("<adminbot-nudge-campaign>", () => {
  it("previews first, and sends only on the second press, confirming the previewed count", async () => {
    const fetcher = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { dry_run: boolean };
      return body.dry_run
        ? reply(200, preview)
        : reply(200, { ...preview, dry_run: false, sent: 2, failed: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    const el = await mount();
    expect(fetcher).not.toHaveBeenCalled();

    el.querySelector<HTMLButtonElement>('[data-testid="nudge-campaign-preview-button"]')!.click();
    await vi.waitFor(() =>
      expect(el.querySelector('[data-testid="nudge-campaign-preview"]')).not.toBeNull(),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`http://adminbot.test${ROUTE}`);
    expect(bodyOf(fetcher.mock.calls[0])).toEqual({ dry_run: true });
    const text = el.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("2 members would get this.");
    expect(text).toContain("Skipped: 1 nudges turned off · 3 already asked.");
    expect(el.querySelectorAll(".nudge-campaign__sample")).toHaveLength(2);

    const sentEvents: Event[] = [];
    document.body.addEventListener("nudge-campaign-sent", (e) => sentEvents.push(e));
    el.querySelector<HTMLButtonElement>('[data-testid="nudge-campaign-send"]')!.click();
    await vi.waitFor(() =>
      expect(el.querySelector('[data-testid="nudge-campaign-done"]')).not.toBeNull(),
    );
    expect(bodyOf(fetcher.mock.calls[1])).toEqual({ dry_run: false, confirm: 2 });
    expect(el.textContent?.replace(/\s+/g, " ")).toContain("Sent to 2 of 2.");
    expect(sentEvents).toHaveLength(1);
  });

  it("offers no send button when nobody would get it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { ...preview, count: 0, samples: [] })),
    );
    const el = await mount();
    el.querySelector<HTMLButtonElement>('[data-testid="nudge-campaign-preview-button"]')!.click();
    await vi.waitFor(() =>
      expect(el.querySelector('[data-testid="nudge-campaign-preview"]')).not.toBeNull(),
    );
    expect(el.querySelector('[data-testid="nudge-campaign-send"]')).toBeNull();
  });

  it("shows the server's refusal when the roster moved since the preview", async () => {
    const fetcher = vi.fn(async (_url: string, init: { body: string }) =>
      (JSON.parse(init.body) as { dry_run: boolean }).dry_run
        ? reply(200, preview)
        : reply(409, {
            error: { message: "confirm was 2 but 3 members would be messaged now; preview again." },
          }),
    );
    vi.stubGlobal("fetch", fetcher);
    const el = await mount();
    el.querySelector<HTMLButtonElement>('[data-testid="nudge-campaign-preview-button"]')!.click();
    await vi.waitFor(() =>
      expect(el.querySelector('[data-testid="nudge-campaign-send"]')).not.toBeNull(),
    );
    el.querySelector<HTMLButtonElement>('[data-testid="nudge-campaign-send"]')!.click();
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')).not.toBeNull());
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("preview again");
  });
});

describe("<adminbot-nudge-campaigns>", () => {
  it("lists each campaign with who it has reached", async () => {
    const fetcher = vi.fn(async () =>
      reply(200, {
        campaigns: [
          {
            key: "example_campaign",
            label: "Ask members on Slack",
            description: "d",
            route: ROUTE,
            cooldown_days: null,
            scheduled: false,
            members_reached: 4,
            last_sent_at: "2026-07-01T10:00:00.000Z",
          },
          {
            key: "profile_photo",
            label: "Profile photo guidelines",
            description: "d",
            route: "/profile-photo/review/run",
            cooldown_days: 0,
            scheduled: true,
            members_reached: 0,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await import("./nudge-campaign.ts");
    const el = document.createElement("adminbot-nudge-campaigns") as AdminBotNudgeCampaigns;
    el.baseUrl = "http://adminbot.test";
    el.sessionToken = "synthetic-session";
    document.body.append(el);
    await vi.waitFor(() => expect(el.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(fetcher.mock.calls[0][0]).toBe("http://adminbot.test/nudges/campaigns");
    const row = el
      .querySelector('[data-campaign="example_campaign"]')
      ?.textContent?.replace(/\s+/g, " ");
    expect(row).toContain("once per member");
    expect(row).toContain("4");
    expect(row).toContain("2026-07-01");
    expect(
      el.querySelector('[data-campaign="profile_photo"]')?.textContent?.replace(/\s+/g, " "),
    ).toContain("(scheduled)");
  });
});
