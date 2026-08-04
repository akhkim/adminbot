/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AdminBotLabMember,
  type AdminBotPaperRecord,
  createEmptyAdminBotDashboardData,
} from "../controllers/adminbot.ts";
import { renderAdminBot, type AdminBotProps } from "./adminbot.ts";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return { ...members[0]!, ...overrides };
}

const members: AdminBotLabMember[] = [
  {
    id: "pat",
    name: "Pat Doe",
    email: "pat@lab.co",
    privilege_level: "core_member",
    access: [],
    status: "active",
    research_topics: ["robotics"],
    projects: ["Atlas"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
];

function baseProps(overrides: Partial<AdminBotProps> = {}): AdminBotProps {
  return {
    panel: "members",
    connected: true,
    loading: false,
    error: null,
    data: { ...createEmptyAdminBotDashboardData(), members, loadedAt: Date.now() },
    busyActionId: null,
    notice: null,
    onRefresh: () => undefined,
    onApprove: () => undefined,
    onRemove: () => undefined,
    onExecute: () => undefined,
    onSaveMember: () => undefined,
    onSaveOwnProfile: () => undefined,
    onSavePaper: () => undefined,
    onDeletePaper: () => undefined,
    onSaveSettings: () => undefined,
    onSaveSensitiveInfo: () => undefined,
    reimbursement: {
      messages: [],
      draft: {},
      missingFields: [],
      receiptNames: [],
      ready: false,
      busy: false,
      error: null,
      artifacts: [],
    },
    onReimbursementMessage: () => undefined,
    onGenerateReimbursement: () => undefined,
    onResetReimbursement: () => undefined,
    memberNudge: {
      channel: "slack",
      message: "",
      subject: "",
      selectedMemberIds: [],
      busy: false,
    },
    onNudgeChannelChange: () => undefined,
    onNudgeMessageChange: () => undefined,
    onNudgeSubjectChange: () => undefined,
    onNudgeToggleRecipient: () => undefined,
    onNudgeSetRecipients: () => undefined,
    onSendNudge: () => undefined,
    ...overrides,
  };
}

// jsdom has no Popover API; the form submit handlers close their popover after saving.
beforeAll(() => {
  (HTMLElement.prototype as { hidePopover?: () => void }).hidePopover ??= () => undefined;
});

function renderToDiv(props: AdminBotProps): HTMLElement {
  const container = document.createElement("div");
  render(renderAdminBot(props), container);
  return container;
}

describe("renderAdminBot members panel — edit affordance", () => {
  it("renders a per-row Edit action and a prefilled edit popover in admin mode", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));

    // The spreadsheet gains an Actions column with a per-row Edit button.
    const editButton = container.querySelector<HTMLButtonElement>(
      'tbody tr button[popovertarget="adminbot-edit-member-0"]',
    );
    expect(editButton).not.toBeNull();
    expect(editButton?.textContent?.trim()).toBe("Edit");

    // The Edit button targets a matching prefilled popover.
    const popover = container.querySelector<HTMLElement>("#adminbot-edit-member-0");
    expect(popover).not.toBeNull();
    expect(popover?.hasAttribute("popover")).toBe(true);

    const idInput = popover?.querySelector<HTMLInputElement>('input[name="id"]');
    expect(idInput?.value).toBe("pat");
    // The id is locked so the upsert edits the existing record rather than forking a new one.
    expect(idInput?.hasAttribute("readonly")).toBe(true);

    const nameInput = popover?.querySelector<HTMLInputElement>('input[name="name"]');
    expect(nameInput?.value).toBe("Pat Doe");

    const privilege = popover?.querySelector<HTMLSelectElement>('select[name="privilegeLevel"]');
    expect(privilege?.value).toBe("core_member");

    // The Add-member popover still exists alongside per-row editing.
    expect(container.querySelector("#adminbot-add-member")).not.toBeNull();
  });

  it("defaults a new member's privilege select to external_collaborator", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    const privilege = container.querySelector<HTMLSelectElement>(
      '#adminbot-add-member select[name="privilegeLevel"]',
    );

    expect(privilege?.value).toBe("external_collaborator");
    expect([...(privilege?.options ?? [])].map((option) => option.value)).toEqual([
      "external_collaborator",
      "trial",
      "member",
      "core_member",
      "admin",
    ]);
  });

  // Regression: the Slack user ID is self-editable but had no cell in the Lab
  // Members spreadsheet, so a saved edit looked like it never landed.
  it("renders the Slack user id in the roster Contact column and search index", () => {
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: [{ ...members[0]!, slack_user_id: "U0123456789" }],
          loadedAt: Date.now(),
        },
      }),
    );
    const row = container.querySelector<HTMLTableRowElement>("tbody tr");

    expect(row?.textContent).toContain("Slack: U0123456789");
    expect(row?.getAttribute("data-search")).toContain("u0123456789");
  });

  it("exposes no edit UI at all for a general member who is not on the roster", () => {
    const container = renderToDiv(baseProps({ mode: "general", signedInMemberId: null }));

    expect(container.querySelector("tbody tr button")).toBeNull();
    expect(container.querySelector('[id^="adminbot-edit-member"]')).toBeNull();
    expect(container.querySelector('[id^="adminbot-self-edit-member"]')).toBeNull();
    expect(container.querySelector("#adminbot-add-member")).toBeNull();
    // The spreadsheet is the single roster view; no separate read-only card list.
    expect(container.querySelector(".adminbot-editor-list--readonly")).toBeNull();
  });

  it("gives a non-admin member a self-edit affordance on their own row only", () => {
    const roster = [member({ id: "pat", name: "Pat Doe" }), member({ id: "sam", name: "Sam Roe" })];
    const container = renderToDiv(
      baseProps({
        mode: "general",
        signedInMemberId: "sam",
        data: { ...createEmptyAdminBotDashboardData(), members: roster, loadedAt: Date.now() },
      }),
    );
    const rows = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")];

    // Own row sorts first and carries the self-edit button; the other row has none.
    expect(rows.map((row) => row.querySelector("small")?.textContent)).toEqual(["sam", "pat"]);
    expect(rows[0]?.querySelector("button")?.getAttribute("popovertarget")).toBe(
      "adminbot-self-edit-member-0",
    );
    expect(rows[1]?.querySelector("button")).toBeNull();

    // Only the self-edit popover exists, and it has no governance inputs at all.
    expect(container.querySelector('[id^="adminbot-edit-member"]')).toBeNull();
    const popover = container.querySelector<HTMLElement>("#adminbot-self-edit-member-0");
    expect(popover).not.toBeNull();
    expect(popover?.querySelector('[name="privilegeLevel"]')).toBeNull();
    expect(popover?.querySelector('[name="status"]')).toBeNull();
    expect(popover?.querySelector('[name="email"]')).toBeNull();
    expect(popover?.querySelector('[name="id"]')).toBeNull();
  });

  it("shows a 'view onboarding checklist' reopen button only on the signed-in member's own row", () => {
    const clicks: string[] = [];
    const roster = [member({ id: "pat", name: "Pat Doe" }), member({ id: "sam", name: "Sam Roe" })];
    const container = renderToDiv(
      baseProps({
        mode: "general",
        signedInMemberId: "pat",
        onShowOnboardingWelcome: () => clicks.push("shown"),
        data: { ...createEmptyAdminBotDashboardData(), members: roster, loadedAt: Date.now() },
      }),
    );
    const rows = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")];
    const ownButtons = [...(rows[0]?.querySelectorAll("button") ?? [])];
    const otherButtons = [...(rows[1]?.querySelectorAll("button") ?? [])];

    const reopenButton = ownButtons.find((btn) => btn.textContent?.includes("onboarding"));
    expect(reopenButton).toBeTruthy();
    expect(otherButtons.some((btn) => btn.textContent?.includes("onboarding"))).toBe(false);

    reopenButton?.click();
    expect(clicks).toEqual(["shown"]);
  });

  it("omits the onboarding reopen button when no handler is provided", () => {
    const container = renderToDiv(baseProps({ mode: "general", signedInMemberId: "pat" }));
    const button = [...container.querySelectorAll("tbody tr button")].find((btn) =>
      btn.textContent?.includes("onboarding"),
    );
    expect(button).toBeUndefined();
  });

  it("routes a self-edit submit to onSaveOwnProfile with whitelisted fields only", () => {
    const saved: Array<[string, Record<string, unknown>]> = [];
    const container = renderToDiv(
      baseProps({
        mode: "general",
        signedInMemberId: "pat",
        onSaveOwnProfile: (memberId, fields) => saved.push([memberId, fields]),
        onSaveMember: () => {
          throw new Error("self-edit must not use the admin upsert path");
        },
      }),
    );
    const form = container.querySelector<HTMLFormElement>("#adminbot-self-edit-member-0 form");
    form?.querySelector<HTMLInputElement>('input[name="role"]')?.setAttribute("value", "");
    const roleInput = form?.querySelector<HTMLInputElement>('input[name="role"]');
    if (roleInput) {
      roleInput.value = "Research scientist";
    }
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(saved).toHaveLength(1);
    const [memberId, fields] = saved[0]!;
    expect(memberId).toBe("pat");
    expect(fields.role).toBe("Research scientist");
    expect(fields.name).toBe("Pat Doe");
    // Governance keys can never appear — the form has no inputs for them.
    expect(Object.keys(fields)).not.toContain("privilege_level");
    expect(Object.keys(fields)).not.toContain("status");
    expect(Object.keys(fields)).not.toContain("email");
  });

  it("keeps the full admin edit path on every row, including other members", () => {
    const roster = [member({ id: "pat", name: "Pat Doe" }), member({ id: "sam", name: "Sam Roe" })];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        signedInMemberId: "sam",
        data: { ...createEmptyAdminBotDashboardData(), members: roster, loadedAt: Date.now() },
      }),
    );
    const rows = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")];

    expect(rows.map((row) => row.querySelector("button")?.getAttribute("popovertarget"))).toEqual([
      "adminbot-edit-member-0",
      "adminbot-edit-member-1",
    ]);
    expect(container.querySelector('[id^="adminbot-self-edit-member"]')).toBeNull();
    // Admin popovers keep the governance field set.
    expect(
      container.querySelector('#adminbot-edit-member-1 select[name="privilegeLevel"]'),
    ).not.toBeNull();
  });

  it("drops the dedicated Actions column and nests Edit under the person name", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent?.trim());

    expect(headers).not.toContain("Actions");
    const firstCell = container.querySelector<HTMLTableCellElement>("tbody tr td");
    expect(firstCell?.querySelector("strong")?.textContent).toBe("Pat Doe");
    expect(firstCell?.querySelector("button")?.textContent?.trim()).toBe("Edit");
    // Row cell count now matches the header count exactly.
    expect(container.querySelectorAll("tbody tr td")).toHaveLength(headers.length);
  });
});

describe("renderAdminBot papers panel — inline paper nudges", () => {
  it("renders due paper nudges inside the Active papers panel in admin mode", () => {
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "papers",
        data: {
          ...createEmptyAdminBotDashboardData(),
          papers: [],
          nudges: [
            {
              type: "author_nudge",
              paper_id: "paper-1",
              title: "World Models Survey",
              step: "slide_making",
              recipients: ["alice"],
              message: "Please nudge the authors.",
            },
          ],
        },
      }),
    );

    expect(container.textContent).toContain("Paper nudges");
    expect(container.textContent).toContain("World Models Survey");
    expect(container.textContent).toContain("Please nudge the authors.");
  });
});

describe("renderAdminBot announcements panel", () => {
  it("shows a subject field only for the email channel", () => {
    const slack = renderToDiv(baseProps({ mode: "admin", panel: "announcements" }));
    expect(slack.querySelector('input[placeholder="Lab announcement"]')).toBeNull();

    const email = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "announcements",
        memberNudge: {
          channel: "email",
          message: "",
          subject: "",
          selectedMemberIds: [],
          busy: false,
        },
      }),
    );
    expect(email.querySelector('input[placeholder="Lab announcement"]')).not.toBeNull();
  });

  it("offers only conferences with live papers, and tags each recipient with theirs", () => {
    const roster = [
      member({ id: "pat", name: "Pat Doe" }),
      member({ id: "sam", name: "Sam Roe", slack_user_id: "U2" }),
    ];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "announcements",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: roster,
          papers: [
            paper({ id: "live", authors: ["Pat Doe"] }),
            // Finished work: its venue must not appear as something to announce about.
            paper({
              id: "done",
              authors: ["Sam Roe"],
              artifacts: { conference: "ICML 2025", topic: "Old" },
              reminder: { status: "complete" },
            }),
          ],
          loadedAt: Date.now(),
        },
      }),
    );

    const select = container.querySelector<HTMLSelectElement>(
      '.adminbot-nudge-recipients select[name="conference"]',
    );
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
      "",
      "NeurIPS 2026",
    ]);

    // The list comes from the active papers, not from the roster: a paper whose authors match no
    // member record still contributes its venue.
    const orphan = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "announcements",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: roster,
          papers: [
            paper({
              id: "orphan",
              authors: ["Nobody On The Roster"],
              artifacts: { conference: "ICLR 2027", topic: "Unmatched" },
            }),
          ],
          loadedAt: Date.now(),
        },
      }),
    );
    expect(
      [
        ...(orphan.querySelector<HTMLSelectElement>(
          '.adminbot-nudge-recipients select[name="conference"]',
        )?.options ?? []),
      ].map((option) => option.value),
    ).toEqual(["", "ICLR 2027"]);

    const rows = [
      ...container.querySelectorAll<HTMLTableRowElement>(".adminbot-nudge-recipients tbody tr"),
    ];
    expect(rows.find((row) => row.dataset.memberId === "pat")?.dataset.conferences).toBe(
      "NeurIPS 2026",
    );
    expect(rows.find((row) => row.dataset.memberId === "sam")?.dataset.conferences).toBe("");
  });

  it("disables the checkbox for a member missing the selected channel's contact field", () => {
    const roster = [
      member({ id: "with-slack", name: "With Slack", slack_user_id: "U1", email: undefined }),
      member({ id: "no-slack", name: "No Slack", slack_user_id: undefined }),
    ];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "announcements",
        data: { ...createEmptyAdminBotDashboardData(), members: roster, loadedAt: Date.now() },
      }),
    );
    const rows = [
      ...container.querySelectorAll<HTMLTableRowElement>(".adminbot-nudge-recipients tbody tr"),
    ];
    const withSlackCheckbox = rows
      .find((row) => row.dataset.memberId === "with-slack")
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const noSlackCheckbox = rows
      .find((row) => row.dataset.memberId === "no-slack")
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(withSlackCheckbox?.disabled).toBe(false);
    expect(noSlackCheckbox?.disabled).toBe(true);
  });

  it("toggles a recipient via onNudgeToggleRecipient when its checkbox changes", () => {
    const toggled: string[] = [];
    const roster = [member({ id: "pat", name: "Pat Doe", slack_user_id: "U1" })];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "announcements",
        data: { ...createEmptyAdminBotDashboardData(), members: roster, loadedAt: Date.now() },
        onNudgeToggleRecipient: (memberId) => toggled.push(memberId),
      }),
    );
    const checkbox = container.querySelector<HTMLInputElement>(
      '.adminbot-nudge-recipients input[type="checkbox"]',
    );
    checkbox?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toggled).toEqual(["pat"]);
  });

  it("select all visible adds every unhidden row's id to the existing selection", () => {
    let recipients: string[] = [];
    const roster = [
      member({ id: "a", name: "A", slack_user_id: "U1" }),
      member({ id: "b", name: "B", slack_user_id: "U2" }),
    ];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "announcements",
        data: { ...createEmptyAdminBotDashboardData(), members: roster, loadedAt: Date.now() },
        memberNudge: {
          channel: "slack",
          message: "",
          subject: "",
          selectedMemberIds: ["existing"],
          busy: false,
        },
        onNudgeSetRecipients: (ids) => {
          recipients = ids;
        },
      }),
    );
    const selectAllButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Select all visible",
    );
    selectAllButton?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(new Set(recipients)).toEqual(new Set(["existing", "a", "b"]));
  });

  it("preselects members who haven't marked the LinkedIn step done, skipping alumni/external", () => {
    let recipients: string[] = [];
    const step = (status: string) => ({ steps: [{ id: "linkedin", status }] });
    const roster = [
      { ...members[0], id: "pending", name: "Pending", onboarding: step("current") },
      { ...members[0], id: "joined", name: "Joined", onboarding: step("complete") },
      { ...members[0], id: "no-checklist", name: "No Checklist", onboarding: null },
      {
        ...members[0],
        id: "left",
        name: "Left",
        status: "alumni" as const,
        onboarding: step("current"),
      },
    ];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "announcements",
        data: { ...createEmptyAdminBotDashboardData(), members: roster, loadedAt: Date.now() },
        memberNudge: {
          channel: "slack",
          message: "",
          subject: "",
          selectedMemberIds: ["existing"],
          busy: false,
        },
        onNudgeSetRecipients: (ids) => {
          recipients = ids;
        },
      }),
    );
    const laggardsButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Select: LinkedIn not joined",
    );
    laggardsButton?.dispatchEvent(new Event("click", { bubbles: true }));
    // A member with no checklist at all counts as not-joined; alumni are never nudged, and the
    // existing manual selection is kept (additive, like "Select all visible").
    expect(new Set(recipients)).toEqual(new Set(["existing", "pending", "no-checklist"]));
  });

  it("calls onSendNudge when the send button is clicked", () => {
    let sent = false;
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "announcements",
        onSendNudge: () => {
          sent = true;
        },
      }),
    );
    const sendButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Send to"),
    );
    sendButton?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(sent).toBe(true);
  });
});

const item = (
  step: string,
  start: number,
  end: number,
  dependsOn: string[],
): NonNullable<AdminBotPaperRecord["timeline"]>["items"][number] =>
  ({
    step,
    label: stepLabelFixtures[step] ?? step,
    dependency_group: "release",
    depends_on: dependsOn,
    status: "upcoming",
    offset_start_business_day: start,
    offset_end_business_day: end,
    duration_business_days: end - start,
    color: "#2563eb",
  }) as NonNullable<AdminBotPaperRecord["timeline"]>["items"][number];

const stepLabelFixtures: Record<string, string> = {
  brainstorming_docs: "Brainstorming docs",
  overleaf_writing: "Overleaf writing",
  submission: "Submission",
  google_drive_pdf: "Drive PDF",
  slide_making: "Slides",
};

const paper = (overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord => ({
  id: "paper-1",
  title: "World Models Survey",
  authors: ["Pat Doe"],
  current_step: "overleaf_writing",
  artifacts: { conference: "NeurIPS 2026", topic: "World models" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  ...overrides,
});

describe("renderAdminBot members panel — authored papers", () => {
  it("lists a member's papers in their first cell, above the rest of the row", () => {
    const container = renderToDiv(
      baseProps({
        mode: "general",
        panel: "members",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members,
          papers: [paper(), paper({ id: "paper-2", authors: ["Someone Else"] })],
        },
      }),
    );

    const firstCell = container.querySelector("tbody tr td");
    const titles = [
      ...(firstCell?.querySelectorAll(".adminbot-member-sheet__papers .adminbot-tag") ?? []),
    ].map((node) => node.textContent?.trim());
    // Only the papers this member authors, and in the name cell rather than a trailing column.
    expect(titles).toEqual(["World Models Survey"]);
  });

  it("renders no paper strip for a member who authors nothing", () => {
    const container = renderToDiv(
      baseProps({
        mode: "general",
        panel: "members",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members,
          papers: [paper({ id: "paper-2", authors: ["Someone Else"] })],
        },
      }),
    );

    expect(container.querySelector(".adminbot-member-sheet__papers")).toBeNull();
  });
});

describe("renderAdminBot members panel — conference filter", () => {
  it("offers the conferences of the papers members author and tags each row with them", () => {
    const container = renderToDiv(
      baseProps({
        mode: "general",
        panel: "members",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members,
          papers: [paper(), paper({ id: "paper-2", authors: ["Someone Else"] })],
        },
      }),
    );

    const select = container.querySelector<HTMLSelectElement>(
      '.adminbot-member-filters select[name="conference"]',
    );
    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
      "",
      "NeurIPS 2026",
    ]);

    const row = container.querySelector<HTMLTableRowElement>("tbody tr");
    expect(row?.dataset.conferences).toBe("NeurIPS 2026");
  });

  it("marks a member with no papers as matching no conference", () => {
    const container = renderToDiv(
      baseProps({
        mode: "general",
        panel: "members",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members,
          papers: [paper({ authors: ["Someone Else"] })],
        },
      }),
    );

    const row = container.querySelector<HTMLTableRowElement>("tbody tr");
    expect(row?.dataset.conferences).toBe("");
  });
});

describe("renderAdminBot papers panel — member self-service", () => {
  function papersProps(overrides: Partial<AdminBotProps>, papers: AdminBotPaperRecord[]) {
    return baseProps({
      mode: "general",
      panel: "papers",
      signedInMemberId: "pat",
      data: { ...createEmptyAdminBotDashboardData(), members, papers },
      ...overrides,
    });
  }

  it("gives a signed-in member the add-paper form, prefilled with their own name", () => {
    const container = renderToDiv(papersProps({}, [paper()]));

    const addCard = container.querySelector<HTMLElement>("#adminbot-add-paper");
    expect(addCard).not.toBeNull();
    expect(addCard?.querySelector<HTMLInputElement>('input[name="authors"]')?.value).toBe(
      "Pat Doe",
    );
    // Reminder cadence is paper-flow governance the service rejects from a member write.
    expect(addCard?.querySelector('select[name="reminderStatus"]')).toBeNull();
  });

  it("shows the edit form on a paper the member authors and hides it on one they don't", () => {
    const container = renderToDiv(
      papersProps({}, [paper(), paper({ id: "paper-2", authors: ["Someone Else"] })]),
    );

    const forms = [
      ...container.querySelectorAll('[id^="adminbot-edit-paper-"] form.adminbot-form'),
    ];
    expect(forms).toHaveLength(1);
    expect(forms[0]?.querySelector<HTMLInputElement>('input[name="id"]')?.value).toBe("paper-1");
  });

  it("treats a paper the member filed as theirs even when the authors are written differently", () => {
    const container = renderToDiv(
      papersProps({}, [paper({ authors: ["P. Doe"], submitted_by_member_id: "pat" })]),
    );

    expect(
      container.querySelectorAll('[id^="adminbot-edit-paper-"] form.adminbot-form'),
    ).toHaveLength(1);
  });

  it("keeps deletion out of the member view", () => {
    const container = renderToDiv(papersProps({}, [paper()]));

    expect(container.querySelector(".adminbot-paper-gantt__actions .btn.danger")).toBeNull();
  });

  it("stacks concurrent branches into separate lanes so bars never overlap", () => {
    // Slides branch off the submission and overlap the arXiv/announcement chain in time.
    const timeline = {
      progress_percent: 40,
      current_step_index: 2,
      total_estimated_business_days: 12,
      items: [
        item("brainstorming_docs", 0, 2, []),
        item("overleaf_writing", 2, 7, ["brainstorming_docs"]),
        item("submission", 7, 8, ["overleaf_writing"]),
        item("google_drive_pdf", 8, 9, ["submission"]),
        item("slide_making", 8, 10, ["submission"]),
      ],
    };
    const container = renderToDiv(papersProps({}, [paper({ timeline })]));

    const tracks = container.querySelectorAll(".adminbot-paper-timeline__track");
    expect(tracks).toHaveLength(2);
    // The overlapping pair must land on different tracks.
    const laneOf = (label: string) =>
      [...tracks].findIndex((track) => track.textContent?.includes(label));
    expect(laneOf("Drive PDF")).not.toBe(laneOf("Slides"));
    // ...and the linear head of the chain stays on one track.
    expect(laneOf("Brainstorming docs")).toBe(laneOf("Submission"));
  });

  it("keeps a purely linear timeline in a single lane", () => {
    const timeline = {
      progress_percent: 20,
      current_step_index: 1,
      total_estimated_business_days: 8,
      items: [
        item("brainstorming_docs", 0, 2, []),
        item("overleaf_writing", 2, 7, ["brainstorming_docs"]),
        item("submission", 7, 8, ["overleaf_writing"]),
      ],
    };
    const container = renderToDiv(papersProps({}, [paper({ timeline })]));

    expect(container.querySelectorAll(".adminbot-paper-timeline__track")).toHaveLength(1);
  });

  it("anchors the edit control to the paper's own timeline row", () => {
    const container = renderToDiv(papersProps({}, [paper()]));

    const row = container.querySelector(".adminbot-paper-gantt__row");
    expect(row).not.toBeNull();
    // The row owns both the trigger and the popover it opens, so a paper is read and edited in
    // one place instead of a second list underneath.
    const trigger = row?.querySelector<HTMLButtonElement>(
      'button[popovertarget^="adminbot-edit-paper-"]',
    );
    expect(trigger).not.toBeNull();
    expect(row?.querySelector(`#${trigger?.getAttribute("popovertarget")}`)).not.toBeNull();
  });

  it("offers no add-paper form when nobody is signed in", () => {
    const container = renderToDiv(
      baseProps({
        mode: "general",
        panel: "papers",
        data: { ...createEmptyAdminBotDashboardData(), members, papers: [paper()] },
      }),
    );

    expect(container.querySelector("#adminbot-add-paper")).toBeNull();
  });
});
