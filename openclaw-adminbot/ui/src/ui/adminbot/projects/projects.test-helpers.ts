// Synthetic papers, workspace props and host state for the My Projects & Papers tests.
//
// Every write the pages make lands in a recorder rather than reaching a controller, so a test can
// say exactly what a click would have sent to the service.
import { render } from "lit";
import type { PaperSlotOverviewRow } from "../api/paper-admin.ts";
import type { PaperCycle } from "../api/papers.ts";
import type {
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  SlackChannelCheck,
} from "../controllers/admin.ts";
import type { ProjectSummary, ProjectTab } from "./model.ts";
import type { ProjectsNavState } from "./nav.ts";
import { renderProjectsOverview } from "./overview.ts";
import { renderProjectPage } from "./page.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

export function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal abstraction",
    authors: ["Ada Lovelace"],
    current_step: "overleaf_writing",
    submitted_by_member_id: "ada",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

export function overviewRow(overrides: Partial<PaperSlotOverviewRow> = {}): PaperSlotOverviewRow {
  return {
    paper_id: "p1",
    title: "Causal abstraction",
    current_step: "overleaf_writing",
    provided_count: 3,
    required_count: 21,
    dormant: false,
    closed: false,
    missing_slots: ["overleaf"],
    escalating: false,
    ...overrides,
  };
}

/** What GET /my/projects would say about a paper, with one writing task open. */
export function summaryFor(record: AdminBotPaperRecord): ProjectSummary {
  return {
    paper_id: record.id,
    title: record.title,
    current_step: record.current_step,
    venue_targets: [],
    provided_count: 0,
    required_count: 20,
    lanes: {
      core: { open: 1, ready: 1 },
      venue: { open: 0, ready: 0 },
      archive: { open: 0, ready: 0 },
      talk: { open: 0, ready: 0 },
      social: { open: 0, ready: 0 },
    },
    todos: [{ id: "overleaf", label: "Overleaf project", lane: "core", ready: true }],
  };
}

export function emptyCycle(overrides: Partial<PaperCycle> = {}): PaperCycle {
  return {
    slots: [],
    stages: [],
    drafts: [],
    consents: [],
    attendees: [],
    reimbursements: [],
    weeklyUpdates: [],
    cycleClosed: false,
    missingAcceptanceDetails: [],
    ...overrides,
  } as PaperCycle;
}

export type DrawOptions = {
  papers?: AdminBotPaperRecord[];
  /** The active list the service returns. Defaults to every paper given; null is "not read yet". */
  projects?: ProjectSummary[] | null;
  members?: Array<{ id: string; name: string; privilege_level?: string }>;
  onSaveBlocker?: PaperWorkspaceProps["onSaveBlocker"];
  /** Omitted by default, so the control's absence is the tested default rather than an accident. */
  onDeletePaper?: boolean;
  projectDraft?: string | null;
  channelCheck?: SlackChannelCheck;
  overview?: PaperSlotOverviewRow[];
  slots?: Record<string, PaperCycle>;
  /** Omitted by default, so a plain member is what every test draws as. */
  viewerIsAdmin?: boolean;
  notice?: string | null;
  error?: string | null;
  /** Reuse a state object across two draws, for the controls that keep a draft in view state. */
  state?: OverviewState;
  /** Wires the trip handlers, which is what makes the Social tab draw the reader's own trip. */
  trip?: boolean;
  onLoadSlots?: (paperId: string) => void;
};

export type OverviewState = ProjectsNavState & { myProjectsLoading: boolean };

export function makeState(options: DrawOptions = {}): OverviewState {
  const papers = options.papers ?? [paper()];
  return {
    memberId: "ada",
    basePath: "",
    tab: "myWork",
    adminBotLoading: false,
    adminBotData: {
      papers,
      members: options.members ?? [],
      settings: {},
    },
    settings: { adminBotUrl: "https://admin.safe.eu", navCollapsed: false },
    adminBotRecentEdits: {},
    myProjects: options.projects === undefined ? papers.map(summaryFor) : options.projects,
    myProjectsLoading: false,
    myProjectsError: null,
    myProjectsChoosing: false,
    myWorkBlockerDraft: null,
    myWorkCoauthorDraft: {},
    myWorkProjectDraft: options.projectDraft ?? null,
    myWorkProjectAlias: "",
    myWorkProjectError: null,
    myWorkProjectEdits: {},
    myWorkProjectVenues: [],
  } as unknown as OverviewState;
}

export function makeProps(options: DrawOptions = {}) {
  const recorded = {
    saved: [] as AdminBotPaperSaveInput[],
    deleted: [] as string[],
    slotWrites: [] as Array<{ paperId: string; slot: string; input: Record<string, unknown> }>,
    channelToggles: [] as boolean[],
    drafts: [] as Array<{ paperId: string; platform: string; body: string; xThread?: unknown }>,
    recentEdits: [] as Array<[string, string]>,
  };
  const props: PaperWorkspaceProps = {
    onSavePaper: (input) => recorded.saved.push(input),
    onSaveBlocker:
      options.onSaveBlocker ??
      (async (input) => {
        recorded.saved.push(input);
        return true;
      }),
    ...(options.onDeletePaper
      ? { onDeletePaper: (record: AdminBotPaperRecord) => recorded.deleted.push(record.id) }
      : {}),
    ...(options.channelCheck
      ? {
          channelCheck: options.channelCheck,
          onChannelCheckToggle: (enabled: boolean) => recorded.channelToggles.push(enabled),
        }
      : {}),
    ...(options.onLoadSlots ? { onLoadSlots: options.onLoadSlots } : {}),
    overview: options.overview ?? [overviewRow()],
    slots: options.slots ?? {},
    slotsBusyId: null,
    slotsError: options.error ?? null,
    slotsNotice: options.notice ?? null,
    viewerIsAdmin: options.viewerIsAdmin ?? false,
    onSaveSlot: (paperId, slot, input) => recorded.slotWrites.push({ paperId, slot, input }),
    memberId: "ada",
    memberName: (id) => id,
    onSaveDraft: (paperId, platform, body, xThread) =>
      recorded.drafts.push({ paperId, platform, body, ...(xThread ? { xThread } : {}) }),
    onCirculateDraft: () => {},
    onLoadRecentEdits: (subject, id) => recorded.recentEdits.push([subject, id]),
    onConsent: () => {},
    onSetAttendee: () => {},
    onSetReimbursement: () => {},
    ...(options.trip ? { onOpenTravel: () => {} } : {}),
  };
  return { props, recorded };
}

function mount() {
  // Every draw starts from an empty document: an `#id` selector resolves through the document's id
  // map before it checks containment, so a leftover container would answer for the new one.
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

export function drawOverview(options: DrawOptions = {}) {
  const container = mount();
  const state = options.state ?? makeState(options);
  const { props, recorded } = makeProps(options);
  const draw = () => render(renderProjectsOverview(state, props), container);
  draw();
  return { container, state, props, rerender: draw, ...recorded };
}

export function drawPage(options: DrawOptions & { paperId?: string; tab?: ProjectTab } = {}) {
  const container = mount();
  const state = options.state ?? makeState(options);
  const { props, recorded } = makeProps(options);
  const draw = () =>
    render(
      renderProjectPage(state, props, options.paperId ?? "p1", options.tab ?? "project"),
      container,
    );
  draw();
  return { container, state, props, rerender: draw, ...recorded };
}
