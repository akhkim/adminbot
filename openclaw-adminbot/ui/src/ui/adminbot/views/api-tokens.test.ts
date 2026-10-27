import { afterEach, expect, it, vi } from "vitest";
import { clearStoredMemberSession, saveStoredMemberSession } from "../auth/session.ts";
import { ApiTokensSection, CliLoginApproval } from "./api-tokens.ts";

const SECRET = `abt_${"S".repeat(43)}_0badc0de`;
const row = {
  id: `tok_${"1".repeat(20)}`,
  name: "Claude on laptop",
  hint: "c0de",
  created_at: "2026-10-01T00:00:00Z",
  expires_at: "2026-10-31T00:00:00Z",
  ip_count: 1,
};

afterEach(() => {
  document.body.replaceChildren();
  clearStoredMemberSession();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubService(handler: (path: string, init?: RequestInit) => unknown) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, init });
      const body = handler(path, init);
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

it("renders nothing for a member who may not hold tokens", async () => {
  saveStoredMemberSession({ sessionToken: "synthetic-session", expiresAt: "2099-01-01T00:00:00Z" });
  const calls = stubService(() => ({ allowed: false, tokens: [] }));
  const element = document.createElement("adminbot-api-tokens") as ApiTokensSection;
  document.body.append(element);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await element.updateComplete;
  expect(element.shadowRoot!.querySelector("section")).toBeNull();
});

it("shows a new token once and keeps it out of storage", async () => {
  saveStoredMemberSession({ sessionToken: "synthetic-session", expiresAt: "2099-01-01T00:00:00Z" });
  let tokens: unknown[] = [];
  const calls = stubService((path, init) => {
    if (path === "/auth/api-tokens" && init?.method === "POST") {
      tokens = [row];
      return { token: SECRET, api_token: row };
    }
    return { allowed: true, tokens };
  });
  const element = document.createElement("adminbot-api-tokens") as ApiTokensSection;
  document.body.append(element);
  const root = element.shadowRoot!;
  await vi.waitFor(() => expect(root.textContent).toContain("No active tokens"));

  [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("New token"))!.click();
  await element.updateComplete;
  (root.querySelector('[name="name"]') as HTMLInputElement).value = "Claude on laptop";
  expect(root.querySelector('[name="password"]')).toBeNull();
  root
    .querySelector("form")!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

  await vi.waitFor(() =>
    expect(root.querySelector('[data-testid="api-token-issued"]')).not.toBeNull(),
  );
  const minted = calls.find((c) => c.init?.method === "POST")!;
  // The default lasts until revoked or unused for 90 days, so no expires_in_days is sent.
  expect(JSON.parse(minted.init!.body as string)).toEqual({ name: "Claude on laptop" });
  expect(minted.init!.cache).toBe("no-store");
  expect((root.querySelector('[aria-label="New API token"]') as HTMLInputElement).value).toBe(
    SECRET,
  );
  await vi.waitFor(() =>
    expect(root.querySelectorAll('[data-testid="api-token-row"]')).toHaveLength(1),
  );
  const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
  expect(stored).not.toContain(SECRET);

  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Done")!.click();
  await element.updateComplete;
  expect(root.textContent).not.toContain(SECRET);
  expect(root.querySelector('[aria-label="New API token"]')).toBeNull();
});

it("revokes a token only after confirmation", async () => {
  saveStoredMemberSession({ sessionToken: "synthetic-session", expiresAt: "2099-01-01T00:00:00Z" });
  const calls = stubService(() => ({ allowed: true, tokens: [row] }));
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const element = document.createElement("adminbot-api-tokens") as ApiTokensSection;
  document.body.append(element);
  const root = element.shadowRoot!;
  await vi.waitFor(() =>
    expect(root.querySelectorAll('[data-testid="api-token-row"]')).toHaveLength(1),
  );
  const revoke = () =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Revoke")!.click();

  revoke();
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  confirm.mockReturnValue(true);
  revoke();
  await vi.waitFor(() =>
    expect(calls.find((c) => c.init?.method === "DELETE")?.path).toBe(`/auth/api-tokens/${row.id}`),
  );
});

it("approves a CLI login with one click and reports back", async () => {
  saveStoredMemberSession({ sessionToken: "synthetic-session", expiresAt: "2099-01-01T00:00:00Z" });
  const calls = stubService((path) =>
    path === "/auth/device/lookup"
      ? {
          user_code: "BCDF-GHJK",
          name: "adminbot CLI on laptop",
          expires_in_days: 30,
          requested_ip: "203.0.113.7",
          expires_at: "2026-10-27T00:10:00Z",
        }
      : { approved: true },
  );
  const element = document.createElement("adminbot-cli-login") as CliLoginApproval;
  element.code = "BCDF-GHJK";
  document.body.append(element);
  const root = element.shadowRoot!;
  await vi.waitFor(() => expect(root.textContent).toContain("adminbot CLI on laptop"));
  expect(root.textContent).toContain("203.0.113.7");

  expect(root.querySelector('[name="password"]')).toBeNull();
  const done = vi.fn();
  element.addEventListener("cli-login-done", done);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Approve")!.click();
  await vi.waitFor(() =>
    expect(root.querySelector('[data-testid="cli-login-outcome"]')).not.toBeNull(),
  );
  expect(calls.at(-1)!.path).toBe("/auth/device/approve");
  expect(JSON.parse(calls.at(-1)!.init!.body as string)).toEqual({ user_code: "BCDF-GHJK" });
  root.querySelector("button")!.click();
  expect(done).toHaveBeenCalledOnce();
});

it("explains an expired or foreign code instead of offering approval", async () => {
  saveStoredMemberSession({ sessionToken: "synthetic-session", expiresAt: "2099-01-01T00:00:00Z" });
  stubService(
    () => new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 }),
  );
  const element = document.createElement("adminbot-cli-login") as CliLoginApproval;
  element.code = "BCDF-GHJK";
  document.body.append(element);
  const root = element.shadowRoot!;
  await vi.waitFor(() => expect(root.textContent).toContain("expired"));
  expect(
    [...root.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Approve"),
  ).toBe(false);
});
