import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import {
  type AdminBotRegistrationsHost,
  decideAdminBotRegistration,
  loadAdminBotRegistrations,
} from "./registrations.ts";

const pendingClaim = {
  id: "reg-claim",
  kind: "claim",
  email: "ada@lab.co",
  status: "pending",
  created_at: "2026-07-01T10:00:00.000Z",
  member_id: "member-7",
  member_name: "Ada Lovelace",
};

function host(): AdminBotRegistrationsHost {
  return {
    settings: { adminBotUrl: "http://127.0.0.1:8765" } as AdminBotRegistrationsHost["settings"],
    registrations: [],
    registrationsLoading: false,
    registrationsError: null,
    registrationsBusyId: null,
    registrationsNotice: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("adminbot-registrations", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "sess-tok", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the pending queue with the member bearer token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ registrations: [pendingClaim] }));
    const h = host();
    await loadAdminBotRegistrations(h);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8765/auth/registrations?status=pending");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sess-tok");
    expect(h.registrations).toHaveLength(1);
    expect(h.registrationsError).toBeNull();
    expect(h.registrationsLoading).toBe(false);
  });

  it("reports no-session without calling the service", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    vi.stubGlobal("localStorage", createStorageMock());
    const h = host();
    await loadAdminBotRegistrations(h);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.registrationsError).toBe("no-session");
  });

  it("maps a 403 from a non-admin session to a forbidden state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "insufficient privileges" } }, 403),
    );
    const h = host();
    await loadAdminBotRegistrations(h);

    expect(h.registrationsError).toBe("forbidden");
    expect(h.registrations).toEqual([]);
  });

  it("maps a network failure to an unreachable state", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    const h = host();
    await loadAdminBotRegistrations(h);

    expect(h.registrationsError).toBe("unreachable");
    expect(h.registrationsLoading).toBe(false);
  });

  it("approves a registration and refetches the queue", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "approved", member_id: "member-7" }))
      .mockResolvedValueOnce(jsonResponse({ registrations: [] }));
    const h = host();
    h.registrations = [pendingClaim as AdminBotRegistrationsHost["registrations"][number]];
    await decideAdminBotRegistration(h, "reg-claim", "approve");

    const [approveUrl, approveInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(approveUrl).toBe("http://127.0.0.1:8765/auth/registrations/reg-claim/approve");
    expect(approveInit.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:8765/auth/registrations?status=pending",
    );
    expect(h.registrationsNotice).toEqual({ kind: "success", text: "Request approved." });
    expect(h.registrations).toEqual([]);
    expect(h.registrationsBusyId).toBeNull();
  });

  it("rejects a registration through the reject endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "rejected" }))
      .mockResolvedValueOnce(jsonResponse({ registrations: [] }));
    const h = host();
    await decideAdminBotRegistration(h, "reg-signup", "reject");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8765/auth/registrations/reg-signup/reject",
    );
    expect(h.registrationsNotice).toEqual({ kind: "success", text: "Request rejected." });
  });

  it("surfaces a forbidden decision instead of failing silently", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: { message: "insufficient privileges" } }, 403));
    const h = host();
    h.registrations = [pendingClaim as AdminBotRegistrationsHost["registrations"][number]];
    await decideAdminBotRegistration(h, "reg-claim", "approve");

    // A failed decision must not refetch — the queue the admin is looking at stays put.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(h.registrationsNotice).toEqual({
      kind: "error",
      text: "Only admins and core members can approve or reject member requests.",
    });
    expect(h.registrationsBusyId).toBeNull();
    // The request stays in the queue because the decision never landed.
    expect(h.registrations).toHaveLength(1);
  });

  it("surfaces an unreachable decision failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    const h = host();
    await decideAdminBotRegistration(h, "reg-claim", "approve");

    expect(h.registrationsNotice?.kind).toBe("error");
    expect(h.registrationsNotice?.text).toContain("unreachable");
  });
});
