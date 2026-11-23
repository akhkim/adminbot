/* @vitest-environment jsdom */
// The admin's read of API usage: what the page draws from the two reports, and what it leaves out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authedJson = vi.fn();
let storedSession: { sessionToken: string } | null = { sessionToken: "token" };

vi.mock("../auth/session.ts", () => ({
  authedJson: (...args: unknown[]) => authedJson(...args),
  calendarFailure: () => ({ kind: "failed" }),
  loadStoredMemberSession: () => storedSession,
  resolveAdminBotBaseUrl: () => "http://localhost",
}));
vi.mock("../../storage.ts", () => ({ loadSettings: () => ({}) }));

const {
  AdminBotApiUsage,
  clientShareLabel,
  durationLabel,
  errorRate,
  metricsLabel,
  slowestOperations,
} = await import("./api-usage.ts");
type ApiUsageSummary = import("./api-usage.ts").ApiUsageSummary;
type ApiUsageAdoption = import("./api-usage.ts").ApiUsageAdoption;

const count = (requests: number, extra: Partial<Record<string, number>> = {}) => ({
  requests,
  client_errors: 0,
  server_errors: 0,
  avg_ms: 40,
  max_ms: 90,
  ...extra,
});

function summary(): ApiUsageSummary {
  return {
    from: "2026-10-22T00:00:00.000Z",
    days: 30,
    totals: { ...count(12, { client_errors: 1 }), members: 2 },
    by_day: [
      { day: "2026-11-19", ...count(5) },
      { day: "2026-11-20", ...count(7, { client_errors: 1 }) },
    ],
    by_member: [
      {
        member_id: "ada",
        name: "Ada",
        last_at: "2026-11-20T10:00:00.000Z",
        cli_requests: 6,
        token_requests: 2,
        ...count(9),
      },
      {
        member_id: "grace",
        last_at: "2026-11-19T10:00:00.000Z",
        cli_requests: 0,
        token_requests: 0,
        ...count(3),
      },
    ],
    by_operation: [
      { operation: "get-auth-session", method: "GET", ...count(8) },
      { operation: "get-papers", method: "GET", ...count(4, { avg_ms: 900, max_ms: 2400 }) },
    ],
    by_client: [
      { client: "cli", client_version: "1.4.0", ...count(6) },
      { client: "website", ...count(6) },
    ],
  };
}

const runs = {
  jobs: [
    {
      job: "email-automation",
      runs: 3,
      failures: 1,
      avg_ms: 2500,
      last_ok_at: "2026-11-20T09:07:00.000Z",
      metrics: { "emails_status.completed": 5, needs_review: 1 },
    },
  ],
  sweeps: [],
};

function adoption(): ApiUsageAdoption {
  return {
    days: 30,
    dropped_after_days: 30,
    totals: {
      token_holders: 3,
      token_holders_using_cli: 2,
      cli_users_ever: 3,
      cli_users_in_window: 1,
    },
    members: [
      {
        member_id: "ada",
        name: "Ada",
        live_tokens: 1,
        first_cli_at: "2026-11-01T09:00:00.000Z",
        last_cli_at: "2026-11-20T09:00:00.000Z",
      },
      { member_id: "lin", name: "Lin", live_tokens: 1 },
    ],
    weekly_cli_users: [
      { week: "2026-11-09", users: 2 },
      { week: "2026-11-16", users: 1 },
    ],
    power_users: [
      {
        member_id: "ada",
        name: "Ada",
        requests: 9,
        active_days: 4,
        operations: 3,
        cli_requests: 6,
        website_requests: 3,
        other_requests: 0,
        last_at: "2026-11-20T10:00:00.000Z",
        top_operations: [{ operation: "get-papers", method: "GET", requests: 5 }],
      },
    ],
    dropped_off: [
      {
        member_id: "kai",
        name: "Kai",
        first_cli_at: "2026-08-03T09:00:00.000Z",
        last_cli_at: "2026-09-12T09:00:00.000Z",
      },
    ],
  };
}

const emptyAdoption = (): ApiUsageAdoption => ({
  ...adoption(),
  totals: {
    token_holders: 0,
    token_holders_using_cli: 0,
    cli_users_ever: 0,
    cli_users_in_window: 0,
  },
  members: [],
  weekly_cli_users: [],
  power_users: [],
  dropped_off: [],
});

function answer(status: number, body: unknown) {
  return { response: new Response(null, { status }), body };
}

async function mount(): Promise<InstanceType<typeof AdminBotApiUsage>> {
  const element = document.createElement("adminbot-api-usage") as InstanceType<
    typeof AdminBotApiUsage
  >;
  document.body.append(element);
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await element.updateComplete;
  }
  return element;
}

beforeEach(() => {
  storedSession = { sessionToken: "token" };
  authedJson.mockImplementation(async (_base: string, path: string) =>
    path.startsWith("/usage/summary")
      ? answer(200, summary())
      : path.startsWith("/usage/adoption")
        ? answer(200, adoption())
        : answer(200, runs),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  authedJson.mockReset();
});

describe("API usage page", () => {
  it("reads the reports for the window and draws people, operations and runs", async () => {
    const element = await mount();
    expect(authedJson.mock.calls.map((call) => call[1]).toSorted()).toEqual([
      "/usage/adoption?days=30",
      "/usage/automation?days=30",
      "/usage/summary?days=30",
    ]);
    expect(element.querySelector('[data-testid="api-usage-requests"]')?.textContent).toContain(
      "12",
    );
    expect(element.querySelector('[data-testid="api-usage-cli"]')?.textContent).toContain("6");
    expect(element.querySelector('[data-testid="api-usage-member-ada"]')?.textContent).toContain(
      "Ada",
    );
    // A member the service could not name still gets a row, under their id.
    expect(element.querySelector('[data-testid="api-usage-member-grace"]')?.textContent).toContain(
      "grace",
    );
    expect(element.querySelector('[data-testid="api-usage-slowest"]')?.textContent).toContain(
      "get-papers",
    );
    const automation = element.querySelector('[data-testid="api-usage-automation"]');
    expect(automation?.textContent).toContain("email-automation");
    expect(automation?.textContent).toContain("emails_status.completed 5");
    // Newest day first.
    expect(element.querySelector('[data-testid="api-usage-days"] li')?.textContent).toContain(
      "2026-11-20",
    );
  });

  it("draws CLI adoption, power users and who stopped", async () => {
    const element = await mount();
    expect(element.querySelector('[data-testid="api-usage-adoption"]')?.textContent).toContain(
      "2 / 3",
    );
    expect(element.querySelector('[data-testid="api-usage-adopter-lin"]')?.textContent).toContain(
      "Not yet",
    );
    const power = element.querySelector('[data-testid="api-usage-power-ada"]')?.textContent ?? "";
    expect(power).toContain("Ada");
    expect(power).toContain("get-papers");
    expect(power).toContain("CLI 67%");
    // Newest week first.
    expect(element.querySelector('[data-testid="api-usage-weekly"] li')?.textContent).toContain(
      "2026-11-16",
    );
    const dropped = element.querySelector('[data-testid="api-usage-dropped"]')?.textContent ?? "";
    expect(dropped).toContain("Kai");
    expect(dropped).toContain("2026-09-12");
  });

  it("asks for the new window when one is picked", async () => {
    const element = await mount();
    authedJson.mockClear();
    (element.querySelector('[data-testid="api-usage-window-7"]') as HTMLButtonElement).click();
    await element.updateComplete;
    expect(authedJson.mock.calls.map((call) => call[1])).toContain("/usage/summary?days=7");
  });

  it("says so when nothing was recorded, and draws no empty sections", async () => {
    authedJson.mockImplementation(async (_base: string, path: string) =>
      path.startsWith("/usage/summary")
        ? answer(200, {
            ...summary(),
            totals: { ...count(0), members: 0 },
            by_day: [],
            by_member: [],
            by_operation: [],
            by_client: [],
          })
        : path.startsWith("/usage/adoption")
          ? answer(200, emptyAdoption())
          : answer(200, { jobs: [], sweeps: [] }),
    );
    const element = await mount();
    expect(element.querySelector('[data-testid="api-usage-empty"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="api-usage-adoption"]')).toBeNull();
    expect(element.querySelector("table")).toBeNull();
  });

  it("explains a refusal rather than drawing a blank", async () => {
    authedJson.mockResolvedValue(answer(403, { error: "forbidden" }));
    const element = await mount();
    expect(element.querySelector('[data-testid="api-usage-error"]')?.textContent).toContain(
      "Only admins",
    );
  });
});

describe("API usage labels", () => {
  it("formats rates, durations and counters", () => {
    expect(errorRate(count(0))).toBe("0%");
    expect(errorRate(count(40, { client_errors: 1 }))).toBe("2.5%");
    expect(errorRate(count(4, { server_errors: 2 }))).toBe("50%");
    expect(durationLabel(undefined)).toBe("—");
    expect(durationLabel(180)).toBe("180 ms");
    expect(durationLabel(2400)).toBe("2.4 s");
    expect(durationLabel(190_000)).toBe("3m 10s");
    expect(metricsLabel({ a: 1, b: 3 })).toBe("b 3 · a 1");
    expect(
      clientShareLabel({ requests: 4, cli_requests: 1, website_requests: 3, other_requests: 0 }),
    ).toBe("Website 75% · adminbot CLI 25%");
    expect(
      clientShareLabel({ requests: 0, cli_requests: 0, website_requests: 0, other_requests: 0 }),
    ).toBe("—");
  });

  it("ranks slow operations by average and ignores one-off calls", () => {
    const rows = [
      { operation: "rare", method: "GET", ...count(1, { avg_ms: 9000 }) },
      { operation: "slow", method: "GET", ...count(5, { avg_ms: 800 }) },
      { operation: "fast", method: "GET", ...count(50, { avg_ms: 20 }) },
    ];
    expect(slowestOperations(rows).map((row) => row.operation)).toEqual(["slow", "fast"]);
  });
});
