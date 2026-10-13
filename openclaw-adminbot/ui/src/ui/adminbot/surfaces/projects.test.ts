// The wiring behind My Projects & Papers and the head professor's review dialog: which paper opens
// where, which drawing the card list lands on, and that a write asks the sidebar to read again.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import { openPaperForViewer } from "../projects/open-paper.ts";
import { paper } from "../projects/projects.test-helpers.ts";
import {
  paperWorkspaceProps,
  renderPaperReviewSurface,
  renderProjectsSurface,
} from "./projects.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

const controllers = vi.hoisted(() => ({
  saveAdminBotPaper: vi.fn(async () => true),
  loadAdminBotPaperSlots: vi.fn(async () => {}),
  saveAdminBotSocialDraft: vi.fn(async () => {}),
}));
vi.mock("../controllers/admin.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../controllers/admin.ts")>()),
  saveAdminBotPaper: controllers.saveAdminBotPaper,
}));
vi.mock("../controllers/paper-slots.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../controllers/paper-slots.ts")>()),
  loadAdminBotPaperSlots: controllers.loadAdminBotPaperSlots,
  saveAdminBotSocialDraft: controllers.saveAdminBotSocialDraft,
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
});

function host(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "adminbotPapers",
    basePath: "",
    memberId: "head",
    settings: {},
    adminBotData: {
      papers: [paper()],
      members: [],
      settings: { head_professor_member_id: "head" },
    },
    adminBotPaperCardId: null,
    adminBotPiReview: [],
    adminBotPaperSlots: {},
    adminBotPaperSlotOverview: [],
    adminBotTripDrafts: {},
    adminBotPaperNudgeSelected: [],
    myProjects: [],
    setTab(this: AppViewState, tab: AppViewState["tab"]) {
      this.tab = tab;
    },
    ...overrides,
  } as unknown as AppViewState;
}

function scope(overrides: Partial<AdminBotSurfaceScope> = {}): AdminBotSurfaceScope {
  return {
    accessRole: "admin",
    adminBotMode: "admin",
    adminBotPanel: null,
    activePaperCard: undefined,
    hasMemberSession: true,
    needsPapersForTab: true,
    rosterPendingForTab: false,
    logisticsTemplate: "signature",
    logisticsScope: "",
    requestHostUpdate: vi.fn(),
    ...overrides,
  } as AdminBotSurfaceScope;
}

describe("opening a paper from a list", () => {
  it("gives the head professor the review, and reads the paper's cycle for it", () => {
    const state = host();
    openPaperForViewer(state, "p1");
    expect(state.adminBotPaperCardId).toBe("p1");
    expect(controllers.loadAdminBotPaperSlots).toHaveBeenCalledWith(state, "p1");
    expect(state.tab).toBe("adminbotPapers");
  });

  it("takes anybody else to the paper's project page", () => {
    const state = host({ memberId: "ada" });
    openPaperForViewer(state, "p1");
    expect(state.adminBotPaperCardId).toBeNull();
    expect(state.tab).toBe("myWork");
    expect(window.location.pathname).toBe("/my-work/p1");
  });
});

describe("the review dialog surface", () => {
  const draw = (state: AppViewState, over: Partial<AdminBotSurfaceScope> = {}) => {
    const container = document.createElement("div");
    document.body.append(container);
    render(renderPaperReviewSurface(state, scope(over)), container);
    return container;
  };

  it("opens for the head professor on Active Papers and My Desk", () => {
    for (const tab of ["adminbotPapers", "adminbotProfessor"] as const) {
      const container = draw(host({ tab, adminBotPaperCardId: "p1" }), {
        activePaperCard: paper(),
      });
      expect(
        container.querySelector('[data-testid="paper-pi-review"], [role="status"]'),
      ).not.toBeNull();
      expect(container.querySelector('[data-testid="paper-card-dialog"]')).not.toBeNull();
    }
  });

  it("opens from the queue row when the lab list does not carry the paper", () => {
    const container = draw(
      host({
        tab: "adminbotProfessor",
        adminBotPaperCardId: "queued",
        adminBotPiReview: [
          { paperId: "queued", title: "Queued paper", authors: ["Ada"], drivePdfUrl: "" },
        ] as never,
      }),
    );
    expect(container.querySelector(".paper-card-dialog__header")?.textContent).toContain(
      "Queued paper",
    );
  });

  it("opens for nobody else, and nowhere else", () => {
    expect(
      draw(host({ memberId: "ada", adminBotPaperCardId: "p1" }), { activePaperCard: paper() })
        .childElementCount,
    ).toBe(0);
    expect(
      draw(host({ tab: "myWork", adminBotPaperCardId: "p1" }), {
        activePaperCard: paper(),
      }).querySelector('[data-testid="paper-card-dialog"]'),
    ).toBeNull();
  });
});

describe("paperWorkspaceProps", () => {
  it("tells the card list whether the reader administers the lab", () => {
    expect(paperWorkspaceProps(host(), scope({ accessRole: "admin" })).viewerIsAdmin).toBe(true);
    expect(paperWorkspaceProps(host(), scope({ accessRole: "member" })).viewerIsAdmin).toBe(false);
  });

  it("carries no lab-wide nudge into the project pages", () => {
    expect("onNudgeAuthors" in paperWorkspaceProps(host(), scope())).toBe(false);
  });

  it("asks the sidebar to read the project list again once a paper write lands", async () => {
    const state = host();
    const props = paperWorkspaceProps(state, scope());
    props.onSavePaper({ id: "p1", title: "T", authors: [], currentStep: "overleaf_writing" });
    expect(state.myProjects).toEqual([]);
    await vi.waitFor(() => expect(state.myProjects).toBeNull());
  });

  it("passes an X thread through to the draft save", () => {
    const state = host();
    const thread = { stage: "arxiv" as const, posts: [{ text: "1/1 Synthetic" }] };
    paperWorkspaceProps(state, scope()).onSaveDraft("p1", "x", "1/1 Synthetic", thread);
    expect(controllers.saveAdminBotSocialDraft).toHaveBeenCalledWith(
      state,
      "p1",
      "x",
      "1/1 Synthetic",
      thread,
    );
  });
});

describe("renderProjectsSurface", () => {
  it("draws nothing off its own tab, or while the roster it reads is still loading", () => {
    const container = document.createElement("div");
    render(renderProjectsSurface(host({ tab: "dashboard" }), scope()), container);
    expect(container.childElementCount).toBe(0);
    render(
      renderProjectsSurface(host({ tab: "myWork" }), scope({ rosterPendingForTab: true })),
      container,
    );
    expect(container.childElementCount).toBe(0);
  });
});
