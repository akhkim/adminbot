import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingCatalogEntry } from "../auth/session.ts";
import {
  loadMeetingCatalog,
  meetingCatalogOptions,
  shouldLoadMeetingCatalog,
  type AdminBotMeetingCatalogHost,
} from "./meeting-catalog.ts";

const { fetchMeetingCatalog, loadStoredMemberSession } = vi.hoisted(() => ({
  fetchMeetingCatalog: vi.fn(),
  loadStoredMemberSession: vi.fn(),
}));

vi.mock("../auth/session.ts", () => ({
  fetchMeetingCatalog,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl: () => "http://service.test",
}));

const CATALOG: MeetingCatalogEntry[] = [
  {
    topic: "Causal Inference",
    summary: "Theme: Causal Inference",
    family: "theme",
  },
  {
    topic: "Law to Benchmark",
    summary: "Proj: Law to Benchmark",
    family: "project",
  },
];

function host(overrides: Partial<AdminBotMeetingCatalogHost> = {}): AdminBotMeetingCatalogHost {
  return {
    settings: {} as AdminBotMeetingCatalogHost["settings"],
    adminBotMeetingCatalog: [],
    adminBotMeetingCatalogLoading: false,
    adminBotMeetingCatalogCheckedAt: null,
    ...overrides,
  };
}

describe("loadMeetingCatalog", () => {
  beforeEach(() => {
    fetchMeetingCatalog.mockReset();
    loadStoredMemberSession.mockReset();
    loadStoredMemberSession.mockReturnValue({ sessionToken: "token" });
  });

  it("stores what the service served", async () => {
    fetchMeetingCatalog.mockResolvedValue({ ok: true, value: CATALOG });
    const h = host();
    await loadMeetingCatalog(h);

    expect(h.adminBotMeetingCatalog).toEqual(CATALOG);
    expect(h.adminBotMeetingCatalogCheckedAt).not.toBeNull();
    expect(h.adminBotMeetingCatalogLoading).toBe(false);
  });

  it("keeps the list it already had when a read fails, and does not ask again", async () => {
    // The render pass asks once per session. A failure that left the stamp unset would be
    // indistinguishable from never having tried, and the page would refetch on every frame.
    fetchMeetingCatalog.mockResolvedValue({ ok: false, kind: "unreachable" });
    const h = host({ adminBotMeetingCatalog: CATALOG });
    await loadMeetingCatalog(h);

    expect(h.adminBotMeetingCatalog).toEqual(CATALOG);
    expect(shouldLoadMeetingCatalog(h)).toBe(false);
  });

  it("asks for nothing when nobody is signed in", async () => {
    loadStoredMemberSession.mockReturnValue(null);
    const h = host({ adminBotMeetingCatalog: CATALOG });
    await loadMeetingCatalog(h);

    expect(fetchMeetingCatalog).not.toHaveBeenCalled();
    expect(h.adminBotMeetingCatalog).toEqual([]);
    // Still unasked: a member who signs in later gets the picker filled in without a reload.
    expect(shouldLoadMeetingCatalog(h)).toBe(true);
  });
});

describe("meetingCatalogOptions", () => {
  it("offers one box per topic, whatever family it came from", () => {
    expect(
      meetingCatalogOptions([
        {
          topic: "Multi-Agent",
          summary: "Theme: Multi-Agent",
          family: "theme",
        },
        {
          topic: "multi-agent",
          summary: "Proj: multi-agent",
          family: "project",
        },
        { topic: " ", summary: "Theme:  ", family: "theme" },
      ]),
    ).toEqual(["Multi-Agent"]);
  });
});
