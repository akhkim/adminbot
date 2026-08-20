// The Logistics tab's controller: what it puts on host state for each answer the service gives.
//
// Fetch is stubbed rather than a service being started -- what is under test here is the mapping
// from a response to what the member sees, not the routes themselves (those are covered over real
// HTTP in extensions/adminbot/src/api/server.logistics.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession, type LogisticsRequest } from "../auth/session.ts";
import {
  downloadAdminBotLogisticsDocument,
  loadAdminBotLogisticsRequests,
  openAdminBotLogisticsRequest,
  sendAdminBotSignedDocuments,
  setAdminBotLogisticsRequestStatus,
  submitAdminBotLogisticsRequest,
  withdrawAdminBotLogisticsRequest,
  type AdminBotLogisticsHost,
} from "./logistics.ts";

const REQUEST: LogisticsRequest = {
  id: "logreq_1",
  kind: "document_signature",
  member_id: "ada",
  member_name: "Ada",
  status: "submitted",
  submitted_at: "2026-08-02T09:30:00.000Z",
  updated_at: "2026-08-02T09:30:00.000Z",
  documents: [{ name: "form.pdf", size: 12 }],
};

function createHost(): AdminBotLogisticsHost {
  return {
    settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
    memberId: "ada",
    adminBotLogisticsRequests: [],
    adminBotLogisticsRequestsLoading: false,
    adminBotLogisticsRequestsError: null,
    adminBotLogisticsOpenRequest: null,
    adminBotLogisticsOpenRequestId: null,
    adminBotLogisticsOpenLoading: false,
    adminBotLogisticsSubmitting: false,
    adminBotLogisticsSubmitError: null,
    adminBotLogisticsSubmittedId: null,
    adminBotLogisticsSigningId: null,
    adminBotLogisticsDownloadingId: null,
  };
}

function routedFetch(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const match = Object.keys(routes)
      .toSorted((left, right) => right.length - left.length)
      .find((path) => url.includes(path));
    if (!match) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return routes[match]!();
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("logistics controller", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks the member to sign in rather than showing an empty list", async () => {
    const host = createHost();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await loadAdminBotLogisticsRequests(host);
    expect(host.adminBotLogisticsRequestsError).toContain("Sign in");
    // Nothing is attempted without a session: a 401 the member cannot act on is worse than the
    // sentence telling them what to do.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts whatever the service returned on state, without filtering it here", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({ "/logistics/requests": () => json({ requests: [REQUEST] }) });
    await loadAdminBotLogisticsRequests(host);
    expect(host.adminBotLogisticsRequests).toEqual([REQUEST]);
    expect(host.adminBotLogisticsRequestsLoading).toBe(false);
    expect(host.adminBotLogisticsRequestsError).toBeNull();
  });

  it("names the service that could not be reached, since that is the fixable half", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    await loadAdminBotLogisticsRequests(host);
    expect(host.adminBotLogisticsRequestsError).toContain("http://127.0.0.1:8765");
    expect(host.adminBotLogisticsRequests).toEqual([]);
  });

  it("opens one request in full, which is the only read that carries the bytes", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    const withBytes = {
      ...REQUEST,
      documents: [{ name: "form.pdf", size: 5, data_base64: "aGk=" }],
    };
    routedFetch({ "/logistics/requests/logreq_1": () => json(withBytes) });
    await openAdminBotLogisticsRequest(host, "logreq_1");
    expect(host.adminBotLogisticsOpenRequest?.documents?.[0]?.data_base64).toBe("aGk=");
    expect(host.adminBotLogisticsOpenLoading).toBe(false);
  });

  it("goes back to the list when the request cannot be opened", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      "/logistics/requests/logreq_1": () => json({ error: { message: "unknown" } }, 404),
    });
    await openAdminBotLogisticsRequest(host, "logreq_1");
    expect(host.adminBotLogisticsOpenRequestId).toBeNull();
    expect(host.adminBotLogisticsRequestsError).toBeTruthy();
  });

  it("clears the draft only once the service has the request", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({ "/logistics/requests": () => json(REQUEST, 201) });
    const filed = await submitAdminBotLogisticsRequest(
      host,
      {
        kind: "document_signature",
        documents: [{ name: "form.pdf", size: 12 }],
      },
      "ada",
    );
    expect(filed?.id).toBe("logreq_1");
    expect(host.adminBotLogisticsSubmittedId).toBe("logreq_1");
    // Shown in the member's own list straight away, without waiting for a re-read.
    expect(host.adminBotLogisticsRequests).toEqual([REQUEST]);
    expect(host.adminBotLogisticsSubmitting).toBe(false);
  });

  it("keeps the member where they were when a submit is refused, and says why", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      "/logistics/requests": () =>
        json(
          {
            error: {
              message: "a signature request needs at least one document to sign",
            },
          },
          400,
        ),
    });
    const filed = await submitAdminBotLogisticsRequest(
      host,
      { kind: "document_signature", documents: [] },
      "ada",
    );
    expect(filed).toBeNull();
    // The service's own words: it names what was wrong, which no fixed client string could.
    expect(host.adminBotLogisticsSubmitError).toContain("at least one document");
    expect(host.adminBotLogisticsRequests).toEqual([]);
    expect(host.adminBotLogisticsSubmittedId).toBeNull();
  });

  it("replaces the withdrawn request in both places it is held", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    host.adminBotLogisticsRequests = [REQUEST];
    host.adminBotLogisticsOpenRequest = {
      ...REQUEST,
      documents: [{ name: "form.pdf", size: 5, data_base64: "aGk=" }],
    };
    routedFetch({
      "/logistics/requests/logreq_1/withdraw": () => json({ ...REQUEST, status: "withdrawn" }),
    });
    await withdrawAdminBotLogisticsRequest(host, "logreq_1");
    expect(host.adminBotLogisticsRequests[0]?.status).toBe("withdrawn");
    expect(host.adminBotLogisticsOpenRequest?.status).toBe("withdrawn");
  });

  it("lets a withdrawal take the documents off the screen, since that is what it is for", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    host.adminBotLogisticsOpenRequest = {
      ...REQUEST,
      documents: [{ name: "form.pdf", size: 5, data_base64: "aGk=" }],
    };
    routedFetch({
      "/logistics/requests/logreq_1/withdraw": () =>
        json({
          ...REQUEST,
          status: "withdrawn",
          documents: [{ name: "form.pdf", size: 5 }],
        }),
    });
    await withdrawAdminBotLogisticsRequest(host, "logreq_1");
    expect(host.adminBotLogisticsOpenRequest?.documents?.[0]?.data_base64).toBeUndefined();
  });

  it("keeps the bytes an open request was read with when a write replies without them", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    host.adminBotLogisticsRequests = [REQUEST];
    host.adminBotLogisticsOpenRequest = {
      ...REQUEST,
      documents: [{ name: "form.pdf", size: 5, data_base64: "aGk=" }],
    };
    routedFetch({
      "/logistics/requests/logreq_1/status": () =>
        json({
          ...REQUEST,
          status: "completed",
          documents: [{ name: "form.pdf", size: 5 }],
        }),
    });
    await setAdminBotLogisticsRequestStatus(host, "logreq_1", "completed", "signed");
    expect(host.adminBotLogisticsOpenRequest?.status).toBe("completed");
    // The admin is still looking at the document they were reading a moment ago.
    expect(host.adminBotLogisticsOpenRequest?.documents?.[0]?.data_base64).toBe("aGk=");
  });

  it("replaces the row with the closed-out request once the signed document has gone", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    host.adminBotLogisticsRequests = [REQUEST];
    routedFetch({
      "/logistics/requests/logreq_1/signed": () =>
        json({
          ...REQUEST,
          status: "completed",
          signed_sent_to: "ada@cs.toronto.edu",
          signed_sent_at: "2026-08-20T10:00:00.000Z",
          files_cleared_at: "2026-08-20T10:00:00.000Z",
          documents: [{ name: "form.pdf", size: 12 }],
        }),
    });
    const sent = await sendAdminBotSignedDocuments(
      host,
      "logreq_1",
      [{ name: "signed.pdf", size: 0, data_base64: "aGk=" }],
      "Signed all three pages.",
    );
    expect(sent).toBe(true);
    expect(host.adminBotLogisticsRequests[0]?.status).toBe("completed");
    expect(host.adminBotLogisticsRequests[0]?.signed_sent_to).toBe("ada@cs.toronto.edu");
    // The row that had a download on it a moment ago no longer does, which is the point.
    expect(host.adminBotLogisticsRequests[0]?.documents?.[0]?.data_base64).toBeUndefined();
    expect(host.adminBotLogisticsSigningId).toBeNull();
  });

  it("says why a signed document could not be sent, and leaves the row alone", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    host.adminBotLogisticsRequests = [REQUEST];
    routedFetch({
      "/logistics/requests/logreq_1/signed": () =>
        json({ error: { message: "Ada has no email address on the roster" } }, 409),
    });
    const sent = await sendAdminBotSignedDocuments(
      host,
      "logreq_1",
      [{ name: "signed.pdf", size: 0, data_base64: "aGk=" }],
      "",
    );
    expect(sent).toBe(false);
    expect(host.adminBotLogisticsRequestsError).toContain("no email address");
    expect(host.adminBotLogisticsRequests[0]?.status).toBe("submitted");
  });

  it("fetches the one request a download was asked for, and saves the file", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function click(this: HTMLAnchorElement) {
        clicks.push(this);
      },
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:mock",
      revokeObjectURL: () => {},
    });
    routedFetch({
      "/logistics/requests/logreq_1": () =>
        json({ ...REQUEST, documents: [{ name: "form.pdf", size: 5, data_base64: "aGVsbG8=" }] }),
    });

    await downloadAdminBotLogisticsDocument(host, "logreq_1", "form.pdf");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toBe("form.pdf");
    expect(host.adminBotLogisticsDownloadingId).toBeNull();
    expect(host.adminBotLogisticsRequestsError).toBeNull();
  });

  it("says so when the file was cleared while the queue was open", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      // Settled between the queue being drawn and the click: names remain, bytes do not.
      "/logistics/requests/logreq_1": () =>
        json({ ...REQUEST, status: "completed", documents: [{ name: "form.pdf", size: 5 }] }),
    });
    await downloadAdminBotLogisticsDocument(host, "logreq_1", "form.pdf");
    expect(host.adminBotLogisticsRequestsError).toContain("no longer stored");
  });
});
