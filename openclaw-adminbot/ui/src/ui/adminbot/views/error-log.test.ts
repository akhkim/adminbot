/* @vitest-environment jsdom */
// The admin's read of the error log: what a row says, and that resolving one asks the service.
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

const { AdminBotErrorLog, errorGroupPeople, errorGroupWhere } = await import("./error-log.ts");
type ErrorGroup = import("./error-log.ts").ErrorGroup;

function group(fields: Partial<ErrorGroup> = {}): ErrorGroup {
  return {
    id: "err_1",
    kind: "error",
    name: "TypeError",
    message: "x is undefined",
    page: "/papers",
    count: 3,
    members: [
      { id: "ada", name: "Ada" },
      { id: "grace", name: "Grace" },
    ],
    first_seen_at: "2026-09-01T09:00:00.000Z",
    last_seen_at: "2026-09-14T09:00:00.000Z",
    sample_stack: "TypeError: x is undefined\n    at render (app.js:1:2)",
    ...fields,
  };
}

function answer(status: number, body: unknown) {
  return { response: new Response(null, { status }), body };
}

async function mount(): Promise<InstanceType<typeof AdminBotErrorLog>> {
  const element = document.createElement("adminbot-error-log") as InstanceType<
    typeof AdminBotErrorLog
  >;
  document.body.append(element);
  await settle(element);
  return element;
}

async function settle(element: InstanceType<typeof AdminBotErrorLog>): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await element.updateComplete;
  }
}

beforeEach(() => {
  authedJson.mockReset();
  storedSession = { sessionToken: "token" };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the error log page", () => {
  it("says where a problem happened and who hit it", () => {
    expect(errorGroupWhere(group())).toBe("/papers");
    expect(errorGroupWhere(group({ kind: "api", api_method: "PUT", api_path: "/papers/42" }))).toBe(
      "PUT /papers/42, from /papers",
    );
    expect(errorGroupPeople(group())).toBe("Ada, Grace");
    expect(errorGroupPeople(group({ members_capped: true }))).toBe("Ada, Grace and others");
    expect(errorGroupPeople(group({ members: [] }))).toBe("No member recorded");
  });

  it("lists each problem as a row with its count and stack", async () => {
    authedJson.mockResolvedValue(answer(200, { groups: [group()] }));
    const element = await mount();

    expect(authedJson).toHaveBeenCalledWith("http://localhost", "/ops/errors", "GET", "token");
    const row = element.querySelector('[data-testid="error-log-row-err_1"]');
    expect(row?.textContent).toContain("TypeError: x is undefined");
    expect(row?.textContent).toContain("3 times");
    expect(row?.textContent).toContain("Ada, Grace");
    expect(row?.querySelector("pre")?.textContent).toContain("at render");
    // DESIGN.md: rows, not cards.
    expect(element.querySelector(".card")).toBeNull();
  });

  it("says so when nothing is open", async () => {
    authedJson.mockResolvedValue(answer(200, { groups: [] }));
    const element = await mount();
    expect(element.querySelector('[data-testid="error-log-empty"]')).not.toBeNull();
  });

  it("marks a problem resolved and reads the list again", async () => {
    authedJson
      .mockResolvedValueOnce(answer(200, { groups: [group()] }))
      .mockResolvedValueOnce(answer(200, { group: group() }))
      .mockResolvedValueOnce(answer(200, { groups: [] }));
    const element = await mount();
    element.querySelector<HTMLButtonElement>('[data-testid="error-log-resolve-err_1"]')?.click();
    await settle(element);

    expect(authedJson).toHaveBeenNthCalledWith(
      2,
      "http://localhost",
      "/ops/errors/err_1/resolve",
      "POST",
      "token",
    );
    expect(element.querySelector('[data-testid="error-log-row-err_1"]')).toBeNull();
  });

  it("explains a refusal instead of showing an empty list", async () => {
    authedJson.mockResolvedValue(answer(403, null));
    const element = await mount();
    expect(element.querySelector('[data-testid="error-log-error"]')?.textContent).toContain(
      "admin-only",
    );
    expect(element.querySelector('[data-testid="error-log-empty"]')).toBeNull();
  });
});
