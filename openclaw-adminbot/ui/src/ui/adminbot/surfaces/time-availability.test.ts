// The surface asks for the selected member's whole record on every render. What is under test is
// that asking for a record already held does not itself cause another render: the host re-renders
// in a microtask, so a render that always led to another would never yield to the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";
import { renderTimeAvailabilitySurface } from "./time-availability.ts";

// Far more renders than one read can cause, and few enough that a loop fails rather than hangs.
const RENDER_CAP = 50;

function renderLikeLit(held: Record<string, unknown>) {
  let renders = 0;
  const state = {
    tab: "adminbotTimeAvailability",
    memberId: "grace",
    adminBotTimeAvailabilityMemberId: "ada",
    adminBotMemberDetails: { ada: held },
    adminBotData: { members: [] },
    settings: { adminBotUrl: "https://admin.safe.eu" },
  } as unknown as AppViewState & { requestUpdate: () => void };
  const render = () => {
    renders++;
    renderTimeAvailabilitySurface(state, scope);
  };
  const scope = {
    accessRole: "admin",
    rosterPendingForTab: false,
    requestHostUpdate: () => state.requestUpdate(),
  } as unknown as AdminBotSurfaceScope;
  state.requestUpdate = () => {
    if (renders < RENDER_CAP) queueMicrotask(render);
  };
  render();
  return () => renders;
}

describe("time availability surface", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "tok", memberId: "grace" } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["read", { session: "tok", member: { id: "ada" } }],
    ["in flight", { session: "tok", loading: true }],
    ["failed", { session: "tok", failed: true }],
  ])("settles after one render when another member's record is already %s", async (_, held) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const renders = renderLikeLit(held);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renders()).toBeLessThan(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
