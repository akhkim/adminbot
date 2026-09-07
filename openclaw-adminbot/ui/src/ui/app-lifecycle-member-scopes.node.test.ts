// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  applySettingsFromUrlMock,
  connectGatewayMock,
  hasStoredMemberSessionMock,
  loadBootstrapMock,
  loadMemberPrivilegeMock,
  restoreComposerMock,
  resumeMemberSessionMock,
} = vi.hoisted(() => ({
  applySettingsFromUrlMock: vi.fn(),
  connectGatewayMock: vi.fn(),
  hasStoredMemberSessionMock: vi.fn(() => true),
  loadBootstrapMock: vi.fn(),
  loadMemberPrivilegeMock: vi.fn(async () => {}),
  restoreComposerMock: vi.fn<(...args: unknown[]) => boolean>(() => false),
  resumeMemberSessionMock: vi.fn(async () => "resumed"),
}));

vi.mock("./app-gateway.ts", () => ({ connectGateway: connectGatewayMock }));

vi.mock("./adminbot/auth/flow.ts", () => ({
  hasStoredMemberSession: hasStoredMemberSessionMock,
  loadMemberPrivilege: loadMemberPrivilegeMock,
  resumeMemberSession: resumeMemberSessionMock,
}));

vi.mock("./controllers/control-ui-bootstrap.ts", () => ({
  loadControlUiBootstrapConfig: loadBootstrapMock,
}));

vi.mock("./chat/composer-persistence.ts", () => ({
  persistChatComposerState: vi.fn(),
  restoreChatComposerState: restoreComposerMock,
}));

vi.mock("./app-settings.ts", () => ({
  applySettingsFromUrl: applySettingsFromUrlMock,
  attachThemeListener: vi.fn(),
  detachThemeListener: vi.fn(),
  inferBasePath: vi.fn(() => "/"),
  syncTabWithLocation: vi.fn(),
  syncThemeWithSettings: vi.fn(),
}));

vi.mock("./app-polling.ts", () => ({
  startLogsPolling: vi.fn(),
  startNodesPolling: vi.fn(),
  stopLogsPolling: vi.fn(),
  stopNodesPolling: vi.fn(),
  startDebugPolling: vi.fn(),
  stopDebugPolling: vi.fn(),
}));

vi.mock("./app-scroll.ts", () => ({
  observeTopbar: vi.fn(),
  scheduleChatScroll: vi.fn(),
  scheduleLogsScroll: vi.fn(),
}));

import { handleConnected } from "./app-lifecycle.ts";

// The reload path that keeps a gateway token in settings (break-glass/URL-param or a same-tab
// reload) skips the full member-session resume, so privilege is fetched asynchronously while
// connect happens synchronously. Regression: an admin used to connect declaring only
// operator.read, leaving Lab Members' write RPCs failing `missing scope: operator.write` for the
// life of the tab.
function createHost(privilegeLevel: string | null) {
  return {
    basePath: "",
    client: null,
    connectGeneration: 0,
    connected: false,
    tab: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    sessionKey: "main",
    chatMessage: "",
    chatQueue: [],
    pendingGatewayUrl: null as string | null,
    chatComposerProvisionalRestore: null,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: "" as string | null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    popStateHandler: vi.fn(),
    topbarObserver: null,
    // A non-empty token is what selects the skip-the-resume branch.
    settings: { token: "shared-gateway-token", gatewayUrl: "ws://127.0.0.1:18789" },
    memberPrivilegeLevel: privilegeLevel,
  };
}

describe("handleConnected member operator scopes", () => {
  beforeEach(() => {
    applySettingsFromUrlMock.mockReset();
    connectGatewayMock.mockReset();
    loadBootstrapMock.mockReset();
    restoreComposerMock.mockReset();
    restoreComposerMock.mockReturnValue(false);
    hasStoredMemberSessionMock.mockReset();
    hasStoredMemberSessionMock.mockReturnValue(true);
    loadMemberPrivilegeMock.mockReset();
    vi.stubGlobal("window", { addEventListener: vi.fn() });
  });

  it("reconnects when admin privilege resolves after the initial connect", async () => {
    const host = createHost(null);
    loadMemberPrivilegeMock.mockImplementation(async () => {
      host.memberPrivilegeLevel = "admin";
    });

    handleConnected(host as never);
    // Connect is synchronous and happens while privilege is still unknown.
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(connectGatewayMock).toHaveBeenCalledTimes(2);
    });
  });

  it("does not reconnect when the member is not privileged", async () => {
    const host = createHost(null);
    loadMemberPrivilegeMock.mockImplementation(async () => {
      host.memberPrivilegeLevel = "member";
    });

    handleConnected(host as never);
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    await Promise.resolve();
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect when privilege never resolves", async () => {
    const host = createHost(null);
    loadMemberPrivilegeMock.mockImplementation(async () => {});

    handleConnected(host as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect when the host disconnected while privilege was loading", async () => {
    const host = createHost(null);
    loadMemberPrivilegeMock.mockImplementation(async () => {
      host.memberPrivilegeLevel = "admin";
      // A disconnect/reconnect elsewhere bumps the generation.
      host.connectGeneration += 1;
    });

    handleConnected(host as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect when admin privilege was already known at connect", async () => {
    const host = createHost("admin");
    loadMemberPrivilegeMock.mockImplementation(async () => {
      host.memberPrivilegeLevel = "admin";
    });

    handleConnected(host as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);
  });
});
