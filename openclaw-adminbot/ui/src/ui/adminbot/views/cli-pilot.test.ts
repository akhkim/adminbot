import { afterEach, expect, it, vi } from "vitest";
import { clearStoredMemberSession, saveStoredMemberSession } from "../auth/session.ts";
import { CliPilotNotice } from "./cli-pilot.ts";

afterEach(() => {
  document.body.replaceChildren();
  clearStoredMemberSession();
  vi.unstubAllGlobals();
});

it("reports success only after AdminBot saves the CLI rating, and retains a failed comment for retry", async () => {
  saveStoredMemberSession({ sessionToken: "fixture-session", expiresAt: "2099-01-01T00:00:00Z" });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ entry: { rating: 4 } }));
  vi.stubGlobal("fetch", fetch);
  const notice = document.createElement("adminbot-cli-pilot") as CliPilotNotice;
  notice.baseUrl = "http://127.0.0.1:8765";
  document.body.append(notice);
  await notice.updateComplete;
  const root = notice.shadowRoot!;
  expect(root.querySelector("a")?.href).toContain("adminbot-cli-pilot-v2");
  expect(root.querySelector("textarea")!.maxLength).toBe(280);
  root.querySelector("select")!.value = "4";
  root.querySelector("textarea")!.value = "A sample report";
  root.querySelector("form")!.requestSubmit();
  await vi.waitFor(() =>
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Try again"),
  );
  expect(root.querySelector("textarea")!.value).toBe("A sample report");
  root.querySelector("form")!.requestSubmit();
  await vi.waitFor(() =>
    expect(root.querySelector('[role="status"]')?.textContent).toContain("was saved"),
  );
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    feature_id: "adminbot-cli",
    rating: 4,
    comment: "A sample report",
  });
});
