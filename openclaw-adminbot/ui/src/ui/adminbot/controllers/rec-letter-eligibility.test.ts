// @vitest-environment jsdom
// Recommendation-letter eligibility on host state: which reads the render pass makes, and what an
// incident change forgets. Fetch is stubbed; the routes are covered over real HTTP in
// extensions/adminbot/src/api/server.rec-letter-eligibility.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import type { LogisticsRequest } from "../api/logistics.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import {
  createRecLetterEligibilityState,
  loadRecLetterSummaries,
  readRecLetterEligibility,
  recordRecLetterFreezeIncident,
  removeRecLetterFreezeIncident,
  setRecLetterFreezeForm,
  type RecLetterEligibilityHost,
} from "./rec-letter-eligibility.ts";

function createHost(): RecLetterEligibilityHost {
  return {
    settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
    adminBotRecLetter: createRecLetterEligibilityState(),
  };
}

const urlOf = (input: RequestInfo | URL) =>
  input instanceof Request ? input.url : input.toString();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function letter(id: string, memberId: string): LogisticsRequest {
  return {
    id,
    kind: "recommendation_letters",
    member_id: memberId,
    member_name: `Member ${memberId}`,
    status: "submitted",
    submitted_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:00:00.000Z",
  } as LogisticsRequest;
}

describe("rec-letter eligibility controller", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads nothing without a member session", () => {
    const host = createHost();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    readRecLetterEligibility(
      host,
      {
        hasMemberSession: false,
        isAdmin: true,
        lettersFormShowing: true,
        queueShowing: true,
        queue: [letter("r1", "m-alpha")],
        open: null,
      },
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives a member their own read only, never the admin reads", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(urlOf(input));
      return json({ member_id: "m-alpha", status: "eligible", missing: [] });
    });
    const redraw = vi.fn();
    readRecLetterEligibility(
      host,
      {
        hasMemberSession: true,
        isAdmin: false,
        lettersFormShowing: true,
        queueShowing: true,
        queue: [letter("r1", "m-beta")],
        open: letter("r1", "m-beta"),
      },
      redraw,
    );
    await vi.waitFor(() => expect(redraw).toHaveBeenCalled());
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/logistics/eligibility/me");
    expect(host.adminBotRecLetter.own.value?.status).toBe("eligible");
  });

  it("asks for each queue badge once, even across renders", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        json({ summaries: [{ member_id: "m-alpha", status: "not_yet" }] }),
      );
    const queue = [letter("r1", "m-alpha"), letter("r2", "m-alpha")];
    await loadRecLetterSummaries(
      host,
      queue.map((row) => row.member_id),
    );
    await loadRecLetterSummaries(
      host,
      queue.map((row) => row.member_id),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(urlOf(fetchMock.mock.calls[0][0])).toContain("member_ids=m-alpha");
    expect(host.adminBotRecLetter.summaries["m-alpha"]?.status).toBe("not_yet");
  });

  it("refuses to record without a member and a date, without calling the service", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    setRecLetterFreezeForm(host, { memberId: "m-alpha" });
    expect(await recordRecLetterFreezeIncident(host)).toBe(false);
    expect(host.adminBotRecLetter.incidents.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forgets every derived result after a record, and clears the form", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    host.adminBotRecLetter = {
      ...host.adminBotRecLetter,
      summaries: { "m-alpha": { member_id: "m-alpha", status: "eligible" } },
      summariesAsked: { "m-alpha": true },
    };
    setRecLetterFreezeForm(host, { memberId: "m-alpha", occurredOn: "2026-09-01", note: " x " });
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body as string));
        return json({ id: "rlfreeze_1" }, 201);
      }
      return json({ incidents: [{ id: "rlfreeze_1", member_id: "m-alpha" }] });
    });
    expect(await recordRecLetterFreezeIncident(host)).toBe(true);
    expect(bodies[0]).toEqual({
      member_id: "m-alpha",
      occurred_on: "2026-09-01",
      note: "x",
      kind: "hallucinated_citation_desk_rejection",
    });
    const state = host.adminBotRecLetter;
    expect(state.summaries).toEqual({});
    expect(state.summariesAsked).toEqual({});
    expect(state.incidents.form.memberId).toBe("");
    expect(state.incidents.list.map((row) => row.id)).toEqual(["rlfreeze_1"]);
  });

  it("keeps the list and shows the error when a delete fails", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ error: { message: "unknown freeze incident rlfreeze_9" } }, 404),
    );
    expect(await removeRecLetterFreezeIncident(host, "rlfreeze_9")).toBe(false);
    expect(host.adminBotRecLetter.incidents.deletingId).toBeNull();
    expect(host.adminBotRecLetter.incidents.error).toBeTruthy();
  });
});
