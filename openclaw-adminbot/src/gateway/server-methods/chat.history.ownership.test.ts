/**
 * Tests that chat.history stays scoped to the requesting member's own session, so one
 * member's chat transcript is never readable from another member's connection.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();

vi.mock("../sessions/session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../sessions/session-utils.js")>(
    "../sessions/session-utils.js",
  );
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
  };
});

import { chatHandlers } from "./chat.js";

function createContext(): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    loadGatewayModelCatalog: vi.fn().mockResolvedValue([]),
  } as unknown as GatewayRequestContext;
}

function createClient(ownerMemberId?: string, isAdmin = false): GatewayClient {
  return {
    ownerMemberId,
    connect: { scopes: isAdmin ? ["operator.admin"] : [] },
  } as unknown as GatewayClient;
}

function mockEntry(key: string, entry: Record<string, unknown> | undefined) {
  loadSessionEntryMock.mockReturnValue({
    cfg: { agents: { list: [{ id: "main", default: true }] } },
    storePath: "/tmp/openclaw-sessions.json",
    store: entry ? { [key]: entry } : {},
    entry,
    canonicalKey: key,
  });
}

async function callChatHistory(
  params: Record<string, unknown>,
  options: { context: GatewayRequestContext; client?: GatewayClient | null },
): Promise<RespondFn> {
  const respond = vi.fn() as unknown as RespondFn;
  await chatHandlers["chat.history"]({
    req: { id: "req-chat-history" } as never,
    params,
    respond,
    context: options.context,
    client: options.client ?? null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("chat.history ownership", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
  });

  it("hides session info for a session owned by a different member", async () => {
    mockEntry("agent:main:theirs", {
      sessionId: "s-theirs",
      ownerMemberId: "mem-2",
      label: "Their private chat",
    });

    const respond = await callChatHistory(
      { sessionKey: "agent:main:theirs" },
      { context: createContext(), client: createClient("mem-1") },
    );

    const [ok, payload] = (respond as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      boolean,
      Record<string, unknown>,
    ];
    expect(ok).toBe(true);
    const sessionInfo = payload.sessionInfo as Record<string, unknown> | undefined;
    // No label from the other member's entry should leak through once ownership is denied.
    expect(JSON.stringify(sessionInfo)).not.toContain("Their private chat");
  });

  it("exposes session info to its owning member", async () => {
    mockEntry("agent:main:mine", {
      sessionId: "s-mine",
      ownerMemberId: "mem-1",
      label: "My chat",
    });

    const respond = await callChatHistory(
      { sessionKey: "agent:main:mine" },
      { context: createContext(), client: createClient("mem-1") },
    );

    const [ok, payload] = (respond as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      boolean,
      Record<string, unknown>,
    ];
    expect(ok).toBe(true);
    const sessionInfo = payload.sessionInfo as Record<string, unknown> | undefined;
    expect(sessionInfo?.label).toBe("My chat");
  });

  it("exposes session info to an admin regardless of ownership", async () => {
    mockEntry("agent:main:theirs", {
      sessionId: "s-theirs",
      ownerMemberId: "mem-2",
      label: "Their private chat",
    });

    const respond = await callChatHistory(
      { sessionKey: "agent:main:theirs" },
      { context: createContext(), client: createClient("mem-admin", true) },
    );

    const [ok, payload] = (respond as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      boolean,
      Record<string, unknown>,
    ];
    expect(ok).toBe(true);
    const sessionInfo = payload.sessionInfo as Record<string, unknown> | undefined;
    expect(sessionInfo?.label).toBe("Their private chat");
  });
});
