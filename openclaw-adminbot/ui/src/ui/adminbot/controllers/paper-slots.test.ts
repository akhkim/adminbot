// The paper nudge pass: who it is allowed to message, and how it sends.
//
// Fetch is stubbed rather than a service being started -- what is under test is who the controller
// decides to message and how many requests it makes doing it, not the route itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession, type PaperNudgeBatch } from "../auth/session.ts";
import {
  loadAdminBotNudgeBatches,
  nudgeAdminBotPaperAuthors,
  nudgeableBatches,
  type AdminBotPaperSlotsHost,
} from "./paper-slots.ts";

function batch(memberId: string, name = memberId): PaperNudgeBatch {
  return {
    member_id: memberId,
    member_name: name,
    deliverable: true,
    item_count: 1,
    paper_titles: ["A paper"],
    message: "still needs: slides",
  };
}

function member(id: string, privilege: string, status?: string) {
  return { id, name: id, privilege_level: privilege, ...(status ? { status } : {}) };
}

function createHost(members = ROSTER): AdminBotPaperSlotsHost {
  return {
    settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
    adminBotData: { members, settings: {} },
    adminBotPaperSlotOverview: [],
    adminBotPaperSlots: {},
    adminBotPaperSlotsOpen: [],
    adminBotPaperSlotsLoading: false,
    adminBotPaperSlotsError: null,
    adminBotPaperSlotsLoadedAt: null,
    adminBotPaperSlotsNudging: false,
    adminBotPaperSlotsNotice: null,
    adminBotPaperNudgeBatches: null,
    adminBotPaperNudgeLoading: false,
    adminBotPaperNudgeSelected: [],
    adminBotPaperSlotsBusyId: null,
  };
}

const ROSTER = [
  member("ada", "member"),
  member("grace", "admin"),
  member("zhijing-jin", "admin"),
  member("trial-tim", "trial"),
  member("ext-eve", "external_collaborator"),
  member("alum-al", "member", "alumni"),
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("who the nudge pass may message", () => {
  it("keeps full members and drops everyone the lab does not chase", () => {
    const host = createHost();
    const kept = nudgeableBatches(host, [
      batch("ada"),
      batch("grace"),
      batch("trial-tim"),
      batch("ext-eve"),
      batch("alum-al"),
      batch("ghost"),
    ]).map((entry) => entry.member_id);
    // Trial and external have no standing to be chased; alumni have left; "ghost" is on no roster.
    expect(kept).toEqual(["ada", "grace"]);
  });

  it("never messages the head of the lab", () => {
    const host = createHost();
    expect(nudgeableBatches(host, [batch("zhijing-jin"), batch("ada")]).map((e) => e.member_id)) //
      .toEqual(["ada"]);
  });

  it("prefers the configured head professor over the fallback", () => {
    const host = createHost();
    host.adminBotData = { members: ROSTER, settings: { head_professor_member_id: "grace" } };
    const kept = nudgeableBatches(host, [batch("grace"), batch("zhijing-jin")]);
    // With settings naming someone, the hard-coded fallback stops applying.
    expect(kept.map((entry) => entry.member_id)).toEqual(["zhijing-jin"]);
  });
});

describe("nudge pass", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "tok", memberId: "grace" } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters the preview, so what is read is what gets sent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ batches: [batch("ada"), batch("zhijing-jin"), batch("trial-tim")] }),
    );
    const host = createHost();
    await loadAdminBotNudgeBatches(host);
    expect(host.adminBotPaperNudgeBatches?.map((entry) => entry.member_id)).toEqual(["ada"]);
    expect(host.adminBotPaperNudgeSelected).toEqual(["ada"]);
  });

  it("sends one request per recipient instead of one long one", async () => {
    // The long single request is what the public tunnel gives up on, and its error page carries no
    // CORS header, so the page could only report that it could not reach AdminBot at all.
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      bodies.push(String((init as RequestInit).body));
      return json({ created: [{}], skipped: [] });
    });
    const host = createHost();
    host.adminBotPaperNudgeSelected = ["ada", "grace"];
    await nudgeAdminBotPaperAuthors(host);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("ada");
    expect(bodies[1]).toContain("grace");
    expect(host.adminBotPaperSlotsNotice).toContain("2");
    expect(host.adminBotPaperSlotsError).toBeNull();
  });

  it("keeps going when one recipient fails, and says how many did not go out", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        throw new TypeError("Failed to fetch");
      }
      return json({ created: [{}], skipped: [] });
    });
    const host = createHost();
    host.adminBotPaperNudgeSelected = ["ada", "grace"];
    await nudgeAdminBotPaperAuthors(host);
    // The second one still landed: the ledger is stamped per person, so a failure earlier in the
    // list does not cost the people after it.
    expect(host.adminBotPaperSlotsNotice).toContain("1");
    expect(host.adminBotPaperSlotsError).toContain("1 message(s) did not go out");
  });
});
