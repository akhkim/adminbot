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

const { AdminBotApiUsage, durationLabel, errorRate, metricsLabel, slowestOperations } =
  await import("./api-usage.ts");
type ApiUsageSummary = import("./api-usage.ts").ApiUsageSummary;

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
    path.startsWith("/usage/summary") ? answer(200, summary()) : answer(200, runs),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  authedJson.mockReset();
});

describe("API usage page", () => {
  it("reads both reports for the window and draws people, operations and runs", async () => {
    const element = await mount();
    expect(authedJson.mock.calls.map((call) => call[1]).toSorted()).toEqual([
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
        : answer(200, { jobs: [], sweeps: [] }),
    );
    const element = await mount();
    expect(element.querySelector('[data-testid="api-usage-empty"]')).not.toBeNull();
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
