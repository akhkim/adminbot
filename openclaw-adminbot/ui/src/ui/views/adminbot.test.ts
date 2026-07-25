/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AdminBotLabMember,
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
