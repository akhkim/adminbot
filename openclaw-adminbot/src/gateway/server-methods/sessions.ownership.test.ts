/**
 * Tests that sessions.list, sessions.describe, and sessions.delete stay scoped to the
 * requesting member's own sessions, and that sessions.create stamps ownership.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const listSessionsFromStoreAsyncMock = vi.fn();
const loadCombinedSessionStoreForGatewayMock = vi.fn();
const resolveGatewaySessionStoreTargetWithStoreMock = vi.fn();
const resolveFreshestSessionEntryFromStoreKeysMock = vi.fn();
// sessions.delete calls the real (unmocked) loadSessionEntry, which internally calls
// resolveGatewaySessionStoreTargetWithStore/resolveFreshestSessionStoreMatchFromStoreKeys via its
// own intra-module reference -- mocking those exports doesn't intercept that internal call, so
// loadSessionEntry itself has to be mocked directly for delete-path tests.
const loadSessionEntryMock = vi.fn();

vi.mock("../sessions/session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../sessions/session-utils.js")>(
    "../sessions/session-utils.js",
  );
  return {
    ...actual,
    listSessionsFromStoreAsync: (...args: unknown[]) => listSessionsFromStoreAsyncMock(...args),
    loadCombinedSessionStoreForGateway: (...args: unknown[]) =>
      loadCombinedSessionStoreForGatewayMock(...args),
    resolveGatewaySessionStoreTargetWithStore: (...args: unknown[]) =>
      resolveGatewaySessionStoreTargetWithStoreMock(...args),
    resolveFreshestSessionEntryFromStoreKeys: (...args: unknown[]) =>
      resolveFreshestSessionEntryFromStoreKeysMock(...args),
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
  };
});

const applySessionsPatchToStoreMock = vi.fn();
vi.mock("../sessions/sessions-patch.js", async () => {
  const actual = await vi.importActual<typeof import("../sessions/sessions-patch.js")>(
    "../sessions/sessions-patch.js",
  );
  return {
    ...actual,
    applySessionsPatchToStore: (...args: unknown[]) => applySessionsPatchToStoreMock(...args),
  };
});

const createSessionEntryWithTranscriptMock = vi.fn();
vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    createSessionEntryWithTranscript: (...args: unknown[]) =>
      createSessionEntryWithTranscriptMock(...args),
  };
});

import { sessionsHandlers } from "./sessions.js";

function createContext(extra: Partial<GatewayRequestContext> = {}): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    loadGatewayModelCatalog: vi.fn().mockResolvedValue([]),
    ...extra,
  } as unknown as GatewayRequestContext;
}

function createRespond(): RespondFn {
  return vi.fn() as unknown as RespondFn;
}

function createClient(ownerMemberId?: string, isAdmin = false): GatewayClient {
  return {
    ownerMemberId,
    connect: { scopes: isAdmin ? ["operator.admin"] : [] },
  } as unknown as GatewayClient;
}

async function callSessions(
  method: keyof typeof sessionsHandlers,
  params: Record<string, unknown>,
  options: { context: GatewayRequestContext; client?: GatewayClient | null; respond?: RespondFn },
): Promise<RespondFn> {
  const respond = options.respond ?? createRespond();
  await sessionsHandlers[method]({
    req: { id: `req-${method}` } as never,
    params,
    respond,
    context: options.context,
    client: options.client ?? null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("sessions.list ownership filtering", () => {
  beforeEach(() => {
    listSessionsFromStoreAsyncMock.mockReset();
    loadCombinedSessionStoreForGatewayMock.mockReset();
  });

  it("only lists sessions owned by the requesting member", async () => {
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/openclaw-sessions.json",
      store: {
        "agent:main:mine": { sessionId: "s-mine", ownerMemberId: "mem-1" },
        "agent:main:theirs": { sessionId: "s-theirs", ownerMemberId: "mem-2" },
        "agent:main:unowned": { sessionId: "s-unowned" },
      },
    });
    listSessionsFromStoreAsyncMock.mockImplementation(async ({ store }) => ({
      sessions: Object.keys(store).map((key) => ({ key })),
    }));

    const respond = await callSessions(
      "sessions.list",
      {},
      { context: createContext(), client: createClient("mem-1") },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: [
          { key: "agent:main:mine", hasActiveRun: false },
          { key: "agent:main:unowned", hasActiveRun: false },
        ],
      }),
      undefined,
    );
  });

  it("lists every session for an admin requester", async () => {
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/openclaw-sessions.json",
      store: {
        "agent:main:mine": { sessionId: "s-mine", ownerMemberId: "mem-1" },
        "agent:main:theirs": { sessionId: "s-theirs", ownerMemberId: "mem-2" },
      },
    });
    listSessionsFromStoreAsyncMock.mockImplementation(async ({ store }) => ({
      sessions: Object.keys(store).map((key) => ({ key })),
    }));

    const respond = await callSessions(
      "sessions.list",
      {},
      { context: createContext(), client: createClient("mem-admin", true) },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: [
          { key: "agent:main:mine", hasActiveRun: false },
          { key: "agent:main:theirs", hasActiveRun: false },
        ],
      }),
      undefined,
    );
  });
});

describe("sessions.create ownership stamping", () => {
  beforeEach(() => {
    applySessionsPatchToStoreMock.mockReset();
    createSessionEntryWithTranscriptMock.mockReset();
    applySessionsPatchToStoreMock.mockResolvedValue({
      ok: true,
      entry: { sessionId: "new-sess" },
    });
    createSessionEntryWithTranscriptMock.mockImplementation(async (_params, callback) => {
      const result = await callback({ sessionEntries: {} });
      if (!result.ok) {
        return result;
      }
      return { ok: true, entry: result.entry };
    });
  });

  function createCreateContext(): GatewayRequestContext {
    return createContext({
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    });
  }

  it("stamps the creating member's id as the new session's owner", async () => {
    const respond = await callSessions(
      "sessions.create",
      {},
      { context: createCreateContext(), client: createClient("mem-1") },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entry: expect.objectContaining({ ownerMemberId: "mem-1" }),
      }),
      undefined,
    );
  });

  it("leaves ownerMemberId unset for an unauthenticated/shared-secret client", async () => {
    const respond = await callSessions(
      "sessions.create",
      {},
      { context: createCreateContext(), client: null },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entry: expect.not.objectContaining({ ownerMemberId: expect.anything() }),
      }),
      undefined,
    );
  });

  it("does not overwrite an owner already set by the patch projection", async () => {
    applySessionsPatchToStoreMock.mockResolvedValue({
      ok: true,
      entry: { sessionId: "new-sess", ownerMemberId: "mem-original" },
    });

    const respond = await callSessions(
      "sessions.create",
      {},
      { context: createCreateContext(), client: createClient("mem-1") },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entry: expect.objectContaining({ ownerMemberId: "mem-original" }),
      }),
      undefined,
    );
  });
});

describe("sessions.delete ownership rejection", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
  });

  function mockEntry(key: string, entry: Record<string, unknown> | undefined) {
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry,
      canonicalKey: key,
      legacyKey: undefined,
    });
  }

  it("rejects deleting a session owned by a different member", async () => {
    mockEntry("agent:main:theirs", { sessionId: "s-theirs", ownerMemberId: "mem-2" });

    const respond = await callSessions(
      "sessions.delete",
      { key: "agent:main:theirs" },
      { context: createContext(), client: createClient("mem-1") },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("belongs to a different member"),
      }),
    );
  });

  it("allows an admin to delete a session owned by a different member", async () => {
    mockEntry("agent:main:theirs", { sessionId: "s-theirs", ownerMemberId: "mem-2" });

    const respond = await callSessions(
      "sessions.delete",
      { key: "agent:main:theirs" },
      { context: createContext(), client: createClient("mem-admin", true) },
    );

    expect(respond).not.toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("belongs to a different member"),
      }),
    );
  });
});

describe("sessions.describe ownership filtering", () => {
  beforeEach(() => {
    resolveGatewaySessionStoreTargetWithStoreMock.mockReset();
    resolveFreshestSessionEntryFromStoreKeysMock.mockReset();
  });

  function mockTarget(key: string, entry: Record<string, unknown> | undefined) {
    resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: key,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      storeKeys: [key],
    });
    resolveFreshestSessionEntryFromStoreKeysMock.mockReturnValue(entry);
  }

  it("returns null for a session owned by a different member", async () => {
    mockTarget("agent:main:theirs", { sessionId: "s-theirs", ownerMemberId: "mem-2" });

    const respond = await callSessions(
      "sessions.describe",
      { key: "agent:main:theirs" },
      { context: createContext(), client: createClient("mem-1") },
    );

    expect(respond).toHaveBeenCalledWith(true, { session: null }, undefined);
  });

  it("returns the session for its owning member", async () => {
    mockTarget("agent:main:mine", { sessionId: "s-mine", ownerMemberId: "mem-1" });

    const respond = await callSessions(
      "sessions.describe",
      { key: "agent:main:mine" },
      { context: createContext(), client: createClient("mem-1") },
    );

    expect(respond).not.toHaveBeenCalledWith(true, { session: null }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ session: expect.objectContaining({ key: "agent:main:mine" }) }),
      undefined,
    );
  });
});
