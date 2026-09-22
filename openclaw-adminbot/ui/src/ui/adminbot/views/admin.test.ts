/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AdminBotLabMember,
  type AdminBotLabMemberSaveInput,
  type AdminBotPaperRecord,
  createEmptyAdminBotDashboardData,
} from "../controllers/admin.ts";
import { PROFILE_FIELDS } from "../member-fields.ts";
import { renderAdminBot, type AdminBotProps } from "./admin.ts";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return { ...members[0]!, ...overrides };
}

const members: AdminBotLabMember[] = [
  {
    id: "pat",
    name: "Pat Doe",
    email: "pat@lab.co",
    privilege_level: "admin",
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
    selectedActionIds: [],
    bulkActionBusy: false,
    onToggleActionSelected: () => undefined,
    onSetSelectedActions: () => undefined,
    onRemoveSelectedActions: () => undefined,
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

/**
 * Render the panel with every row's edit popover built, which is what a person sees.
 *
 * The roster sheet defers each row's edit form until its Edit button is first clicked, so that
 * 77 popovers' worth of fields are not built for forms nobody opened. In a browser the click
 * opens the popover natively and repaints in the same tick; here the click is made and the panel
 * re-rendered, which is the same two steps. Assertions about the editor stay written the way they
 * were -- query the container -- rather than every one of them learning about the deferral.
 *
 * `openEditors: false` renders it the way the panel first paints, for the tests that are about the
 * deferral itself.
 */
function renderToDiv(props: AdminBotProps, options: { openEditors?: boolean } = {}): HTMLElement {
  const container = document.createElement("div");
  render(renderAdminBot(props), container);
  if (options.openEditors === false) {
    return container;
  }
  // By the popover they target, not by class: the row's edit-history button shares that class and
  // fetches on click, and clicking it here would make "nothing is asked for until somebody asks"
  // untestable.
  const editButtons = container.querySelectorAll<HTMLButtonElement>(
    'button[popovertarget^="adminbot-edit-member-"], button[popovertarget^="adminbot-self-edit-member-"]',
  );
  if (editButtons.length === 0) {
    return container;
  }
  for (const button of editButtons) {
    button.click();
  }
  render(renderAdminBot(props), container);
  return container;
}

// The members sheet draws an edit popover for every row up front, so anything inside one is paid
// for once per person on the roster. `timezone` offers the 418 zones Intl knows: as a per-row
// <select> that was 32,682 <option> nodes for 77 people -- 95% of everything on the page, none of
// it visible until somebody clicks Edit -- and the panel took ~3.4s to render where the papers
// panel, same popover-per-row shape and same row count, took 190ms. One shared <datalist> is
// referenced by id, so the list exists once however many rows there are.
describe("renderAdminBot members panel — long option lists are shared, not repeated", () => {
  const roster = Array.from({ length: 12 }, (_, i) =>
    member({ id: `m${i}`, name: `Member ${i}`, email: `m${i}@lab.co` }),
  );
  const draw = (count: number) =>
    renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: roster.slice(0, count),
          loadedAt: Date.now(),
        },
      }),
    );

  it("renders the timezone list once for the whole sheet, not once per row", () => {
    const container = draw(12);
    const lists = container.querySelectorAll("datalist#adminbot-field-options-timezone");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.querySelectorAll("option").length).toBeGreaterThan(40);
    // And no row carries its own copy.
    expect(container.querySelectorAll('select[name="timezone"]')).toHaveLength(0);
  });

  it("points every row's timezone control at that one list", () => {
    const container = draw(12);
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[name="timezone"]')];
    expect(inputs.length).toBeGreaterThan(1);
    for (const input of inputs) {
      expect(input.getAttribute("list")).toBe("adminbot-field-options-timezone");
    }
  });

  // The property that actually keeps the panel fast: adding people must not multiply the option
  // nodes. Short vocabularies (status, privilege) still inline per row and do scale -- the point
  // is that the long one no longer does.
  it("does not grow the timezone option count as the roster grows", () => {
    const count = (n: number) =>
      draw(n).querySelectorAll("datalist#adminbot-field-options-timezone option").length;
    expect(count(12)).toBe(count(1));
  });
});

// Each roster row carries an edit popover holding a ~19-field form. For 77 people that was four
// fifths of the panel's DOM, built for forms nobody had opened. The form now waits for the first
// click on that row's Edit button.
describe("renderAdminBot members panel — the edit form waits to be asked for", () => {
  // Ids unique to this block: the set of opened editors is module state that outlives one test,
  // so a shared id would let an earlier test's click decide this one's answer.
  const lazyRoster = [
    member({ id: "lazy-one", name: "Lazy One", email: "one@lab.co" }),
    member({ id: "lazy-two", name: "Lazy Two", email: "two@lab.co" }),
  ];
  const lazyProps = () =>
    baseProps({
      mode: "admin",
      data: { ...createEmptyAdminBotDashboardData(), members: lazyRoster, loadedAt: Date.now() },
    });

  it("draws the popover shell but not the form, until a row is opened", () => {
    const container = renderToDiv(lazyProps(), { openEditors: false });
    // The shell has to exist: `popovertarget` resolves against its id, so without it the button
    // has nothing to open.
    expect(container.querySelector("#adminbot-edit-member-0")).not.toBeNull();
    expect(container.querySelector("#adminbot-edit-member-0 form")).toBeNull();
    // No row carries a field yet. The one that remains is the Add-member form, which is rendered
    // once for the sheet rather than per row and is meant to be ready to type into.
    expect(
      container.querySelectorAll('[id^="adminbot-edit-member-"] input[name="timezone"]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('input[name="timezone"]')).toHaveLength(1);
  });

  it("builds that row's form on the click, and only that row's", () => {
    const props = lazyProps();
    const container = document.createElement("div");
    render(renderAdminBot(props), container);
    container
      .querySelector<HTMLButtonElement>("button[popovertarget=adminbot-edit-member-0]")
      ?.click();
    render(renderAdminBot(props), container);
    expect(container.querySelector("#adminbot-edit-member-0 form")).not.toBeNull();
    expect(container.querySelector("#adminbot-edit-member-1 form")).toBeNull();
  });

  // Deferred, not mounted-and-unmounted. Once a row's form is built it stays built, so a draft
  // typed into it is still there when the popover is reopened and the autosave timer still has a
  // form in the tree to read.
  it("keeps the form once built, including what was typed into it", () => {
    const props = lazyProps();
    const container = document.createElement("div");
    render(renderAdminBot(props), container);
    container
      .querySelector<HTMLButtonElement>("button[popovertarget=adminbot-edit-member-1]")
      ?.click();
    render(renderAdminBot(props), container);
    const role = container.querySelector<HTMLInputElement>(
      '#adminbot-edit-member-1 input[name="location"]',
    );
    expect(role).not.toBeNull();
    role!.value = "half typed";
    // Another render for any reason at all -- a roster refresh, a notice landing.
    render(renderAdminBot(props), container);
    expect(
      container.querySelector<HTMLInputElement>('#adminbot-edit-member-1 input[name="location"]')
        ?.value,
    ).toBe("half typed");
  });

  // The deferral is about when the markup is built, never about what is in it.
  it("offers the same fields it always did once opened", () => {
    const opened = renderToDiv(lazyProps());
    const names = [...opened.querySelectorAll<HTMLElement>("#adminbot-edit-member-0 [name]")].map(
      (el) => el.getAttribute("name"),
    );
    for (const field of PROFILE_FIELDS.filter((entry) => entry.type !== "image")) {
      expect(names, field.key).toContain(field.key);
    }
    expect(names).toContain("id");
    expect(names).toContain("privilegeLevel");
  });
});

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
    expect(privilege?.value).toBe("admin");

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
      "admin",
    ]);
  });

  it("offers the collaborator subgroup only while the privilege select says external collaborator", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    const form = container.querySelector<HTMLElement>("#adminbot-add-member");
    const field = form?.querySelector<HTMLElement>("[data-collaborator-subgroup-field]");
    const subgroup = form?.querySelector<HTMLSelectElement>('select[name="collaboratorSubgroup"]');

    // A new member defaults to external_collaborator, so the field starts visible.
    expect(field?.hidden).toBe(false);
    expect([...(subgroup?.options ?? [])].map((option) => option.value)).toEqual([
      "",
      "interviewee",
      "slightly_better_than_emails",
      "acquaintance",
      "alumni",
      "own_pace_advisee",
      "coauthor_minor",
      "coauthor_major",
      "coauthor_discussant_designer",
      "disappearing_coauthor",
      "external_prof",
    ]);
    expect([...(subgroup?.options ?? [])].map((option) => option.textContent?.trim())).toContain(
      "Slightly Better Than Emails",
    );

    const privilege = form?.querySelector<HTMLSelectElement>('select[name="privilegeLevel"]');
    privilege!.value = "member";
    privilege!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(field?.hidden).toBe(true);

    // The prefilled edit popover for a core member starts hidden for the same reason.
    const editField = container.querySelector<HTMLElement>(
      "#adminbot-edit-member-0 [data-collaborator-subgroup-field]",
    );
    expect(editField?.hidden).toBe(true);
  });

  // The roster is written down two paths that do not know about each other, so one person can be
  // two half-records. The panel is a comparison an admin resolves, never an automatic merge.
  it("offers to combine two records that look like one person", () => {
    const saved: Array<[string, string]> = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: [
            member({ id: "terry-jingchen-zhang", name: "Terry Jingchen Zhang", email: "t@lab.co" }),
            member({
              id: "terry-zhang",
              name: "Terry Zhang",
              email: "terry@cs.test",
              slack_user_id: "U09",
            }),
          ],
          loadedAt: Date.now(),
        },
        onMergeMembers: (survivorId, duplicateId) => saved.push([survivorId, duplicateId]),
      }),
    );
    const panel = container.querySelector('[data-testid="member-duplicates"]');
    expect(panel).not.toBeNull();
    // Either record can be the survivor -- only a human knows which spelling the lab uses.
    expect(
      panel?.querySelector('[data-testid="member-merge-terry-jingchen-zhang-terry-zhang"]'),
    ).not.toBeNull();
    expect(
      panel?.querySelector('[data-testid="member-merge-terry-zhang-terry-jingchen-zhang"]'),
    ).not.toBeNull();

    globalThis.confirm = () => true;
    panel
      ?.querySelector<HTMLButtonElement>(
        '[data-testid="member-merge-terry-jingchen-zhang-terry-zhang"]',
      )
      ?.click();
    expect(saved).toEqual([["terry-jingchen-zhang", "terry-zhang"]]);
  });

  it("offers the address-less purge only when there is something in it, and previews without a confirm", () => {
    const calls: boolean[] = [];
    const reachable = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: [member({ id: "pat", email: "pat@lab.co" })],
          loadedAt: Date.now(),
        },
        onPurgeMembersWithoutEmail: (dryRun) => calls.push(dryRun),
      }),
    );
    expect(reachable.querySelector('[data-testid="members-without-email"]')).toBeNull();

    const container = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: [
            member({ id: "pat", email: "pat@lab.co" }),
            // Reachable at one address each, so neither is a candidate.
            member({ id: "cal", email: undefined, calendar_email: "cal@lab.co" }),
            member({ id: "corr", email: undefined, correspondence_email: "corr@lab.co" }),
            member({ id: "ghost", name: "Ghost Row", email: undefined }),
          ],
          loadedAt: Date.now(),
        },
        onPurgeMembersWithoutEmail: (dryRun) => calls.push(dryRun),
      }),
    );
    const panel = container.querySelector('[data-testid="members-without-email"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("1 members with no email on file");
    expect(panel?.textContent).toContain("Ghost Row");

    // Preview is a read, so it asks nothing.
    globalThis.confirm = () => false;
    panel
      ?.querySelector<HTMLButtonElement>('[data-testid="members-without-email-preview"]')
      ?.click();
    expect(calls).toEqual([true]);

    // The delete does, and a refused confirm deletes nothing.
    panel?.querySelector<HTMLButtonElement>('[data-testid="members-without-email-purge"]')?.click();
    expect(calls).toEqual([true]);

    globalThis.confirm = () => true;
    panel?.querySelector<HTMLButtonElement>('[data-testid="members-without-email-purge"]')?.click();
    expect(calls).toEqual([true, false]);
  });

  it("deletes a member from the edit card, and only on a confirmation", () => {
    const deleted: string[] = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        onDeleteMember: (target) => deleted.push(target.id),
      }),
    );
    const button = container.querySelector<HTMLButtonElement>('[data-testid="member-delete-pat"]');
    expect(button).not.toBeNull();

    globalThis.confirm = () => false;
    button?.click();
    expect(deleted).toEqual([]);

    globalThis.confirm = () => true;
    button?.click();
    expect(deleted).toEqual(["pat"]);
  });

  it("renders no delete affordance without a handler", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    expect(container.querySelector('[data-testid="member-delete-pat"]')).toBeNull();
    expect(container.querySelector('[data-testid="members-without-email"]')).toBeNull();
  });

  it("merges nothing without a confirmation", () => {
    const saved: Array<[string, string]> = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: [
            member({ id: "miu-nicole-takagi", name: "Miu Nicole Takagi" }),
            member({ id: "miu-takagi", name: "Miu Takagi", email: "miu@cs.test" }),
          ],
          loadedAt: Date.now(),
        },
        onMergeMembers: (survivorId, duplicateId) => saved.push([survivorId, duplicateId]),
      }),
    );
    globalThis.confirm = () => false;
    container
      .querySelector<HTMLButtonElement>('[data-testid="member-merge-miu-takagi-miu-nicole-takagi"]')
      ?.click();
    expect(saved).toEqual([]);
  });

  it("keeps the panel off the page when there is nothing to combine", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    expect(container.querySelector('[data-testid="member-duplicates"]')).toBeNull();
  });

  // The whole point of the shared registry: the roster editor and the member's own profile page
  // ask for the same facts. It used to be twenty fields against twenty-seven, so an admin looking
  // at a record could not fill in a preferred name, a CV link or any social but GitHub.
  it("offers every member field the profile page does", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    const popover = container.querySelector<HTMLElement>("#adminbot-edit-member-0");
    const missing = PROFILE_FIELDS.filter(
      (field) => !popover?.querySelector(`[name="${field.key}"]`),
    ).map((field) => field.key);
    expect(missing).toEqual([]);
  });

  // adminBotAdminOwnedProfileFields is empty at present -- `linkedin_urn` was its last entry and is
  // now an ordinary required field -- so the first half of this asserts a rule over nothing today.
  // It stays anyway: the rule is what makes the list safe to repopulate, and a test that only ran
  // while a particular field happened to be on it would be gone by the time it mattered.
  it("keeps admin-only fields out of a member's own edit form", () => {
    const container = renderToDiv(
      // `mode` is admin-or-general; the self-edit popover is what a non-admin gets on their own
      // row, which is the general roster view plus a signed-in member id.
      baseProps({ mode: "general", signedInMemberId: "pat" }),
    );
    const popover = container.querySelector<HTMLElement>("#adminbot-self-edit-member-0");
    for (const owned of PROFILE_FIELDS.filter((field) => field.adminOnly)) {
      expect(popover?.querySelector(`[name="${owned.key}"]`)).toBeNull();
    }
    // Everything else is still there -- the restriction is the flag, not a shorter list. With the
    // list empty that is every field in the registry, the URN among them.
    const missing = PROFILE_FIELDS.filter(
      (field) => !field.adminOnly && !popover?.querySelector(`[name="${field.key}"]`),
    ).map((field) => field.key);
    expect(missing).toEqual([]);
    expect(popover?.querySelector('[name="linkedin_urn"]')).not.toBeNull();
  });

  // The nudge allowlist. Its whole value is that somebody chose each name, so the editor has to be
  // able to say "no" as clearly as it says "yes" -- and an unchecked box submits nothing at all,
  // which is the case that silently turns a removal into a no-op if the collector reads truthiness.
  describe("nudge list checkbox", () => {
    function submitWith(checked: boolean): AdminBotLabMemberSaveInput[] {
      const saved: AdminBotLabMemberSaveInput[] = [];
      const container = renderToDiv(
        baseProps({ mode: "admin", onSaveMember: (input) => saved.push(input) }),
      );
      const popover = container.querySelector<HTMLElement>("#adminbot-edit-member-0");
      const box = popover?.querySelector<HTMLInputElement>('[name="receivesNudges"]');
      box!.checked = checked;
      popover
        ?.querySelector<HTMLFormElement>("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return saved;
    }

    it("puts somebody on the list", () => {
      expect(submitWith(true)[0]?.receivesNudges).toBe(true);
    });

    it("takes somebody off it, rather than leaving the field unsaid", () => {
      expect(submitWith(false)[0]?.receivesNudges).toBe(false);
    });
  });

  it("sends registry fields in the service's wire shape, typed by the registry", () => {
    const saved: AdminBotLabMemberSaveInput[] = [];
    const container = renderToDiv(
      baseProps({ mode: "admin", onSaveMember: (input) => saved.push(input) }),
    );
    const popover = container.querySelector<HTMLElement>("#adminbot-edit-member-0");
    const set = (key: string, value: string) => {
      const input = popover?.querySelector<HTMLInputElement>(`[name="${key}"]`);
      input!.value = value;
    };
    set("preferred_name", "Pat");
    set("research_topics", "robotics, world models");
    set("hours_per_week", "12");
    popover
      ?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(saved[0]?.profile).toMatchObject({
      preferred_name: "Pat",
      research_topics: ["robotics", "world models"],
      hours_per_week: 12,
    });
    // A field the admin left blank is absent, not "" -- the service reads an empty string as
    // "clear this", so sending every untouched field would wipe the record on each save.
    expect(saved[0]?.profile).not.toHaveProperty("scholar_url");
  });

  it("prefills the subgroup of an external collaborator and sends it with the save", () => {
    const saved: AdminBotLabMemberSaveInput[] = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: [
            member({
              privilege_level: "external_collaborator",
              collaborator_subgroup: "coauthor_major",
            }),
          ],
          loadedAt: Date.now(),
        },
        onSaveMember: (input) => saved.push(input),
      }),
    );
    const popover = container.querySelector<HTMLElement>("#adminbot-edit-member-0");
    const field = popover?.querySelector<HTMLElement>("[data-collaborator-subgroup-field]");
    expect(field?.hidden).toBe(false);
    expect(
      popover?.querySelector<HTMLSelectElement>('select[name="collaboratorSubgroup"]')?.value,
    ).toBe("coauthor_major");

    popover
      ?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(saved[0]?.collaboratorSubgroup).toBe("coauthor_major");

    // The roster shows the subgroup next to the privilege it qualifies.
    expect(container.querySelector("tbody tr")?.textContent).toContain("Coauthor Major");
  });

  it("keeps the subgroup out of the payload once the privilege is no longer collaborator", () => {
    const saved: AdminBotLabMemberSaveInput[] = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: [
            member({
              privilege_level: "external_collaborator",
              collaborator_subgroup: "coauthor_major",
            }),
          ],
          loadedAt: Date.now(),
        },
        onSaveMember: (input) => saved.push(input),
      }),
    );
    const popover = container.querySelector<HTMLElement>("#adminbot-edit-member-0");
    const privilege = popover?.querySelector<HTMLSelectElement>('select[name="privilegeLevel"]');
    privilege!.value = "member";
    privilege!.dispatchEvent(new Event("change", { bubbles: true }));
    popover
      ?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toHaveProperty("collaboratorSubgroup");
  });

  it("hides the subgroup of a member whose privilege is not collaborator", () => {
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          // Stale pairing the service would clear on promotion; the roster must not advertise it.
          members: [member({ privilege_level: "member", collaborator_subgroup: "alumni" })],
          loadedAt: Date.now(),
        },
      }),
    );
    expect(container.querySelector("tbody tr")?.textContent).not.toContain("Alumni");
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
    // Role is a closed vocabulary and takes several answers, so the form offers checkboxes over
    // that vocabulary rather than a select.
    const roleBoxes = [...(form?.querySelectorAll<HTMLInputElement>('input[name="role"]') ?? [])];
    for (const box of roleBoxes) {
      box.checked = box.value === "Industry Researcher" || box.value === "Lab Manager";
    }
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(saved).toHaveLength(1);
    const [memberId, fields] = saved[0]!;
    expect(memberId).toBe("pat");
    // Stored in the vocabulary's order, not the order the boxes happen to sit in the DOM.
    expect(fields.role).toBe("Industry Researcher, Lab Manager");
    expect(fields.name).toBe("Pat Doe");
    // Governance keys can never appear — the form has no inputs for them.
    expect(Object.keys(fields)).not.toContain("privilege_level");
    expect(Object.keys(fields)).not.toContain("status");
    expect(Object.keys(fields)).not.toContain("email");
  });

  // The schedule is edited on the Time Availability tab and stored as validated rows. This form
  // used to send an `availability` string read from a control it does not have, so every save
  // carried "" and the service refused the whole record with "member availability must be a list".
  it("never sends a schedule field from either Lab Members editor", () => {
    const selfSaved: Array<Record<string, unknown>> = [];
    const selfContainer = renderToDiv(
      baseProps({
        mode: "general",
        signedInMemberId: "pat",
        onSaveOwnProfile: (_memberId, fields) => selfSaved.push(fields),
      }),
    );
    selfContainer
      .querySelector<HTMLFormElement>("#adminbot-self-edit-member-0 form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(selfSaved).toHaveLength(1);
    expect(Object.keys(selfSaved[0]!)).not.toContain("availability");

    const adminSaved: AdminBotLabMemberSaveInput[] = [];
    const adminContainer = renderToDiv(
      baseProps({ mode: "admin", onSaveMember: (input) => adminSaved.push(input) }),
    );
    adminContainer
      .querySelector<HTMLFormElement>("#adminbot-edit-member-0 form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(adminSaved).toHaveLength(1);
    expect(Object.keys(adminSaved[0]!)).not.toContain("availability");
  });

  // Email is the login identity. A form that can rewrite it can lock someone out of the account
  // they sign in with, and no admin editing a roster row means to do that.
  it("locks the email of an existing member and leaves it out of the save", () => {
    const saved: AdminBotLabMemberSaveInput[] = [];
    const container = renderToDiv(
      baseProps({ mode: "admin", onSaveMember: (input) => saved.push(input) }),
    );
    const email = container.querySelector<HTMLInputElement>(
      '#adminbot-edit-member-0 input[name="email"]',
    );
    expect(email?.readOnly).toBe(true);
    expect(email?.value).toBe("pat@lab.co");
    expect(
      container.querySelector('#adminbot-edit-member-0 [data-testid="member-form-email-locked"]'),
    ).not.toBeNull();

    container
      .querySelector<HTMLFormElement>("#adminbot-edit-member-0 form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]!)).not.toContain("email");
  });

  // Creation is the one moment the address is a question rather than an established fact.
  it("still asks for an email when adding a member", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    const email = container.querySelector<HTMLInputElement>(
      '#adminbot-add-member input[name="email"]',
    );
    expect(email).not.toBeNull();
    expect(email?.readOnly).toBe(false);
  });

  // Onboarding routes on the Member Type -- `templateForMemberType` picks the guide from it -- so
  // the form that creates a member has to be able to say what they are.
  it("offers the member type on the add-member form", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    const select = container.querySelector<HTMLSelectElement>(
      '#adminbot-add-member select[name="memberType"]',
    );
    expect(select?.value).toBe("");
    const options = [...(select?.options ?? [])].map((option) => option.value);
    expect(options[0]).toBe("");
    expect(options).toContain("full");
    expect(options).toContain("alumni");
  });

  // The column is a comma-separated list and the lab uses tokens before anybody adds them to the
  // shared vocabulary. A select built from that list alone would rewrite the value on the next save.
  it("keeps a stored member type the vocabulary does not list", () => {
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members: [member({ member_type: "alumni, coauthor-major" })],
          loadedAt: Date.now(),
        },
      }),
    );
    const select = container.querySelector<HTMLSelectElement>(
      '#adminbot-edit-member-0 select[name="memberType"]',
    );
    expect(select?.value).toBe("alumni, coauthor-major");
  });

  // Adding somebody to the roster and onboarding them used to be two separate errands.
  it("asks to start onboarding when a member is added, and says so by default", () => {
    const saved: Array<{ id: string; onboard?: boolean }> = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        onSaveMember: (input, options) => saved.push({ id: input.id, onboard: options?.onboard }),
      }),
    );
    const tick = container.querySelector<HTMLInputElement>(
      '#adminbot-add-member [data-testid="member-form-onboard"]',
    );
    expect(tick?.checked).toBe(true);

    const form = container.querySelector<HTMLFormElement>("#adminbot-add-member form");
    form!.querySelector<HTMLInputElement>('input[name="id"]')!.value = "grace";
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(saved).toEqual([{ id: "grace", onboard: true }]);
  });

  it("does not onboard when the tick is cleared", () => {
    const saved: Array<{ onboard?: boolean }> = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        onSaveMember: (_input, options) => saved.push({ onboard: options?.onboard }),
      }),
    );
    const form = container.querySelector<HTMLFormElement>("#adminbot-add-member form");
    form!.querySelector<HTMLInputElement>('input[name="id"]')!.value = "grace";
    form!.querySelector<HTMLInputElement>('[data-testid="member-form-onboard"]')!.checked = false;
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(saved).toEqual([{ onboard: false }]);
  });

  // Editing a row is not adding a member, and re-mailing somebody the lab onboarded months ago is
  // the failure this guards: the edit form carries no such box, so it can never ask for one.
  it("never onboards from the edit-member form", () => {
    const saved: Array<{ onboard?: boolean }> = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        onSaveMember: (_input, options) => saved.push({ onboard: options?.onboard }),
      }),
    );
    expect(
      container.querySelector('#adminbot-edit-member-0 [data-testid="member-form-onboard"]'),
    ).toBeNull();
    container
      .querySelector<HTMLFormElement>("#adminbot-edit-member-0 form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(saved).toEqual([{ onboard: false }]);
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
      // The spelling 22 of the lab's 24 alumni actually carry: the type says they left and the
      // status is absent. Somebody who leaves mid-onboarding has every remaining step unticked
      // forever, so a status-only test swept all of them in on one press.
      {
        ...members[0],
        id: "left-typed",
        name: "Left Typed",
        member_type: "full, alumni",
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
    // A member with no checklist at all counts as not-joined; alumni are never nudged however the
    // roster spells it, and the existing manual selection is kept (additive, like "Select all
    // visible").
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

  it("puts the paper on one scannable row, with its record behind the title", () => {
    const container = renderToDiv(papersProps({}, [paper()]));

    // The Gantt is gone: a chart of every step of every paper answered "how long is this paper"
    // and never "which papers need me today". The per-paper timeline still exists, on that paper's
    // own card in My Projects & Papers, which is where somebody reading one paper already is.
    expect(container.querySelector(".adminbot-paper-timeline__track")).toBeNull();
    expect(container.querySelector('[data-testid="adminbot-paper-overview"]')).not.toBeNull();

    const row = container.querySelector(".paper-overview__row");
    expect(row).not.toBeNull();
    // The title opens the record, so a paper is still read and edited in one place.
    expect(row?.querySelector("button.logistics-requests__open")).not.toBeNull();
    expect(container.querySelector('[id^="adminbot-edit-paper-"]')).not.toBeNull();
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

describe("Next step per paper — reads the slot overview", () => {
  const paper = {
    id: "p1",
    title: "Preserving Historical Truth",
    authors: ["Joeun Yook*"],
    current_step: "arxiv_polish",
  } as never;

  function draw(rows: never) {
    return renderToDiv(
      baseProps({
        mode: "admin",
        panel: "papers",
        paperSlotOverview: rows,
        data: {
          ...createEmptyAdminBotDashboardData(),
          members,
          papers: [paper] as AdminBotPaperRecord[],
          loadedAt: Date.now(),
        },
      }),
    );
  }

  function overview(missing: string[], provided = 8, required = 22) {
    return [
      {
        paper_id: "p1",
        title: "Preserving Historical Truth",
        current_step: "arxiv_polish",
        provided_count: provided,
        required_count: required,
        dormant: false,
        closed: false,
        missing_slots: missing,
      },
    ] as never;
  }

  it("names the first missing slot and what it unblocks", () => {
    const container = draw(overview(["arxiv"]));
    const text = container.textContent ?? "";
    expect(text).toContain("arXiv abstract page");
    expect(text).toContain("unblocks social posts");
  });

  it("counts progress from the slot table, not from artifact links", () => {
    // The old view counted keys in the `artifacts` blob, which disagreed with the card whenever
    // the backfill had not run.
    const container = draw(overview(["arxiv"]));
    expect(container.textContent).toContain("8 of 22 provided");
  });

  it("lists the rest as also open", () => {
    const container = draw(overview(["arxiv", "slides", "poster"]));
    expect(container.textContent).toContain("Also open:");
    expect(container.textContent).toContain("Talk slides");
  });

  it("says who owns it, and calls the PI's slot an approval", () => {
    const container = draw(overview(["pi_approval"]));
    expect(container.textContent).toContain("Approval from");
    expect(container.textContent).toContain("the PI");
  });

  it("skips dormant and closed papers", () => {
    const rows = overview(["arxiv"]) as unknown as Array<Record<string, unknown>>;
    rows[0]!.dormant = true;
    const container = draw(rows as never);
    expect(container.textContent).toContain("Nothing actionable");
  });

  it("ignores a slot this build does not know, rather than crashing", () => {
    // Version skew: the service ships a slot the console has not learned yet.
    const container = draw(overview(["not_a_real_slot", "arxiv"]));
    expect(container.textContent).toContain("arXiv abstract page");
  });
});

describe("pre-registration venue table", () => {
  const papers = [
    {
      id: "a",
      title: "Aimed at both",
      authors: ["Alice", "Bob"],
      current_step: "overleaf_writing",
      artifacts: {
        overleaf_edit_url: "https://overleaf.com/project/abc",
        overleaf_view_url: "https://overleaf.com/read/abc",
        venue_targets: JSON.stringify([
          { venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 50 },
          { venue_id: "arr_2026_october", label: "ARR October", confidence: 99 },
        ]),
      },
    },
    {
      id: "b",
      title: "ICLR only",
      authors: ["Carol"],
      current_step: "overleaf_writing",
      artifacts: {
        venue_targets: JSON.stringify([
          { venue_id: "iclr2027_paper", label: "ICLR 2027", confidence: 80 },
        ]),
      },
    },
    { id: "c", title: "Not registered", authors: [], current_step: "overleaf_writing" },
    {
      id: "e",
      title: "Read-only link only",
      authors: ["Dan"],
      current_step: "overleaf_writing",
      artifacts: {
        // A blank edit field, which is what the grid stores when somebody clears the cell.
        overleaf_edit_url: "   ",
        overleaf_view_url: "https://overleaf.com/read/xyz",
        venue_targets: JSON.stringify([
          { venue_id: "arr_2026_october", label: "ARR October", confidence: 40 },
        ]),
      },
    },
    {
      id: "d",
      title: "Registered from its own card",
      authors: ["Andrew Kim"],
      current_step: "brainstorming_docs",
      artifacts: {
        conference: "ICLR 2027",
        // The shape Add a project and the card's target picker write: a venue-catalog id, with
        // the year in the label rather than in the id.
        venue_targets: JSON.stringify([{ venue_id: "ICLR", label: "ICLR 2027", confidence: 50 }]),
      },
    },
  ] as never as AdminBotPaperRecord[];

  function draw(venueFilter = "") {
    return renderToDiv(
      baseProps({
        mode: "admin",
        panel: "papers",
        venueFilter,
        data: { ...createEmptyAdminBotDashboardData(), members, papers, loadedAt: Date.now() },
      }),
    );
  }

  it("shows one row per paper, not one per venue", () => {
    const board = draw().querySelector('[data-testid="prereg-board"]');
    expect(board?.querySelectorAll("tbody tr")).toHaveLength(4);
  });

  it("lists a paper registered through the card picker, not just through the dialog", () => {
    // The bug: the board filtered targets by exact id against its own venue ids, so a paper
    // registered with a venue-catalog id was dropped -- it read "PRE-REGISTERED 50% ICLR 2027"
    // on its own card and was absent from the ICLR board at the same time.
    const board = draw().querySelector('[data-testid="prereg-board"]');
    expect(board?.textContent).toContain("Registered from its own card");
  });

  it("keeps it when the board is filtered to that venue", () => {
    const board = draw("iclr2027_paper").querySelector('[data-testid="prereg-board"]');
    expect(board?.textContent).toContain("Registered from its own card");
    // And still drops one aimed elsewhere, so the match has not become a catch-all.
    const arr = draw("arr_2026_october").querySelector('[data-testid="prereg-board"]');
    expect(arr?.textContent).not.toContain("Registered from its own card");
  });

  it("omits papers with no venue at all", () => {
    expect(draw().querySelector('[data-testid="prereg-board"]')?.textContent).not.toContain(
      "Not registered",
    );
  });

  // The fixture, by readiness: "Aimed at both" 99 (the only one with an edit link), "ICLR only"
  // 80, "Registered from its own card" 50, "Read-only link only" 40 (edit field stored blank).
  function drawWith(extra: Record<string, unknown>) {
    return renderToDiv(
      baseProps({
        mode: "admin",
        panel: "papers",
        data: { ...createEmptyAdminBotDashboardData(), members, papers, loadedAt: Date.now() },
        ...extra,
      }),
    );
  }

  function titlesOf(container: HTMLElement): string[] {
    return [...container.querySelectorAll('[data-testid="prereg-board"] tbody tr')].map(
      (row) => row.querySelector("td")?.textContent?.trim() ?? "",
    );
  }

  it("sorts by readiness unless told otherwise", () => {
    expect(titlesOf(drawWith({}))[0]).toBe("Aimed at both");
  });

  it("puts the rows that have an edit link first when sorted by edit link", () => {
    const titles = titlesOf(drawWith({ preregSort: "editLink" }));
    // The one paper with an edit link leads; sorting by a column brings what is in it to the top.
    expect(titles[0]).toBe("Aimed at both");
    // A field stored as whitespace is a missing link, not a link, so it stays in the tail.
    expect(titles.slice(1)).toEqual([
      "ICLR only",
      "Registered from its own card",
      "Read-only link only",
    ]);
  });

  it("sorts by title", () => {
    expect(titlesOf(drawWith({ preregSort: "title" }))).toEqual([
      "Aimed at both",
      "ICLR only",
      "Read-only link only",
      "Registered from its own card",
    ]);
  });

  it("puts the rows that have a view link first when sorted by view link", () => {
    // A different column from the edit link: "Aimed at both" and "Read-only link only" both carry
    // a read-only URL and only the first carries an edit URL, so the two orderings are not the
    // same list reshuffled.
    const titles = titlesOf(drawWith({ preregSort: "viewLink" }));
    expect(titles.slice(0, 2)).toEqual(["Aimed at both", "Read-only link only"]);
    expect(titles.slice(2)).toEqual(["ICLR only", "Registered from its own card"]);
  });

  it("keeps a venue on the board after submission closes, until its decisions land", () => {
    // ICLR 2027's paper deadline is 25 Sep 2026 and its decisions are 16 Dec. On the 26th the
    // venue is past submission and unresolved, which is when the board matters most.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    try {
      const chip = drawWith({}).querySelector('[data-testid="venue-filter-iclr2027_paper"]');
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toContain("awaiting results");
      // Its papers are still listed rather than dropped with it.
      expect(titlesOf(drawWith({}))).toContain("ICLR only");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops papers under the confidence threshold", () => {
    expect(titlesOf(drawWith({ preregMinConfidence: 50 }))).not.toContain("Read-only link only");
    expect(titlesOf(drawWith({ preregMinConfidence: 75 }))).toEqual(["Aimed at both", "ICLR only"]);
    // A paper is judged on its best target, not its first: "Aimed at both" is 50% at ICLR and 99%
    // at ARR, and it survives a 75% floor because of the second.
    expect(titlesOf(drawWith({ preregMinConfidence: 75 }))).toContain("Aimed at both");
  });

  it("can show only the rows still missing an edit link", () => {
    const titles = titlesOf(drawWith({ preregMissingEdit: true }));
    expect(titles).toHaveLength(3);
    expect(titles).not.toContain("Aimed at both");
  });

  it("says a filter emptied the board rather than that nobody has registered", () => {
    // 90%+ leaves only "Aimed at both", which is also the one paper that has an edit link, so
    // asking for both at once is genuinely empty rather than merely short.
    const empty = drawWith({ preregMinConfidence: 90, preregMissingEdit: true });
    expect(empty.querySelector('[data-testid="prereg-empty"]')?.textContent).toContain(
      "matches these filters",
    );
    // And still says the plain thing when no filter is on.
    const none = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "papers",
        data: {
          ...createEmptyAdminBotDashboardData(),
          members,
          papers: [papers[2]!],
          loadedAt: Date.now(),
        },
      }),
    );
    expect(none.querySelector('[data-testid="prereg-empty"]')?.textContent).toContain(
      "Nobody has pre-registered",
    );
  });

  it("folds the active papers table into a disclosure that arrives open", () => {
    const container = drawWith({});
    const table = container.querySelector('[data-testid="adminbot-paper-overview"]');
    const details = table?.closest("details.paper-overview__board");
    expect(details).not.toBeNull();
    // Open on arrival: this is the tab's subject, not a detail under it.
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toContain("Active papers");
  });

  it("carries the spreadsheet's columns, with a column per Overleaf link", () => {
    const head = draw().querySelector('[data-testid="prereg-board"] thead');
    expect(
      [...(head?.querySelectorAll("th") ?? [])].map((cell) => cell.textContent?.trim()),
    ).toEqual(["Title", "Venue", "Authors", "Overleaf (edit)", "Overleaf (view)"]);
  });

  it("filtering to a venue drops papers not aimed at it", () => {
    const board = draw("arr_2026_october").querySelector('[data-testid="prereg-board"]');
    expect(board?.textContent).toContain("Aimed at both");
    expect(board?.textContent).not.toContain("ICLR only");
  });

  it("filtering re-ranks by that venue's odds, not the paper's best", () => {
    // Unfiltered, "Aimed at both" leads on its 99% ARR. Filtered to ICLR its 50% puts it second.
    const rows = draw("iclr2027_paper").querySelectorAll('[data-testid="prereg-board"] tbody tr');
    expect(rows[0]?.textContent).toContain("ICLR only");
    expect(rows[1]?.textContent).toContain("Aimed at both");
  });

  it("marks a missing Overleaf link rather than leaving the cell ambiguous", () => {
    const board = draw("iclr2027_paper").querySelector('[data-testid="prereg-board"]');
    expect(board?.querySelector(".venue-table__missing")).not.toBeNull();
  });

  /** The two Overleaf cells of the row whose title contains `title`, in column order. */
  function overleafCells(venue: string, title: string) {
    const row = [...draw(venue).querySelectorAll('[data-testid="prereg-board"] tbody tr')].find(
      (entry) => entry.textContent?.includes(title),
    );
    return [...(row?.querySelectorAll(".venue-table__link") ?? [])];
  }

  // The project link and the read-only share link are different things -- one is who may write,
  // the other is what you send someone you are not adding to the project -- so each gets a column
  // and a row carrying both offers both.
  it("gives each Overleaf link its own column", () => {
    const [edit, view] = overleafCells("arr_2026_october", "Aimed at both");
    expect(edit?.querySelector("a")?.getAttribute("href")).toBe("https://overleaf.com/project/abc");
    expect(edit?.querySelector("a")?.textContent?.trim()).toBe("Edit");
    expect(view?.querySelector("a")?.getAttribute("href")).toBe("https://overleaf.com/read/abc");
    expect(view?.querySelector("a")?.textContent?.trim()).toBe("View");
  });

  // Which link a paper is missing is the thing a column of its own makes readable: the edit cell
  // says "—" while the view cell beside it is filled. A blank stored field is a blank field, not
  // an answer -- reading it as one put a link to nowhere in a column that has its own em dash.
  it("marks the empty column and keeps the filled one when only one link exists", () => {
    const [edit, view] = overleafCells("arr_2026_october", "Read-only link only");
    expect(edit?.querySelector("a")).toBeNull();
    expect(edit?.querySelector(".venue-table__missing")).not.toBeNull();
    expect(view?.querySelector("a")?.getAttribute("href")).toBe("https://overleaf.com/read/xyz");
    expect(view?.querySelector(".venue-table__missing")).toBeNull();
  });
});

// The roster editor takes whatever the admin currently knows: no field blocks the save (the id is
// the upsert key and the one exception), and edits land on the record by themselves after a pause,
// so the Save button is a flush rather than a gate.
describe("renderAdminBot members panel — lenient saves and autosave", () => {
  function editForm(container: HTMLElement): HTMLFormElement {
    const form = container.querySelector<HTMLFormElement>("#adminbot-edit-member-0 form");
    expect(form).not.toBeNull();
    return form!;
  }

  it("puts no required mark on registry fields, calendar email included", () => {
    const container = renderToDiv(baseProps({ mode: "admin" }));
    const form = editForm(container);
    expect(form.querySelector('input[name="calendar_email"]')?.hasAttribute("required")).toBe(
      false,
    );
    // Only the id — the upsert key — may refuse to be blank, and on an edit it is prefilled
    // and readonly, so nothing blocks saving an existing record.
    for (const input of form.querySelectorAll<HTMLInputElement>("input[required]")) {
      expect(input.name).toBe("id");
      expect(input.readOnly).toBe(true);
    }
  });

  it("saves with mandatory-ledger fields blank, omitting them from the patch", () => {
    const saved: AdminBotLabMemberSaveInput[] = [];
    const container = renderToDiv(
      baseProps({ mode: "admin", onSaveMember: (input) => saved.push(input) }),
    );
    const form = editForm(container);
    const calendar = form.querySelector<HTMLInputElement>('input[name="calendar_email"]');
    calendar!.value = "";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe(members[0]!.id);
    // A blank answer is left out of the patch (absent means "leave it alone"), never refused.
    expect("calendar_email" in (saved[0]!.profile ?? {})).toBe(false);
  });

  it("saves with the name box emptied by omitting name, so the stored one survives", () => {
    const saved: AdminBotLabMemberSaveInput[] = [];
    const container = renderToDiv(
      baseProps({ mode: "admin", onSaveMember: (input) => saved.push(input) }),
    );
    const form = editForm(container);
    form.querySelector<HTMLInputElement>('input[name="name"]')!.value = "";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(saved).toHaveLength(1);
    expect("name" in saved[0]!).toBe(false);
  });

  it("autosaves an edit after the typing pause, without the Save button", () => {
    vi.useFakeTimers();
    try {
      const saved: AdminBotLabMemberSaveInput[] = [];
      const container = renderToDiv(
        baseProps({ mode: "admin", onSaveMember: (input) => saved.push(input) }),
      );
      const form = editForm(container);
      const location = form.querySelector<HTMLInputElement>('input[name="location"]');
      location!.value = "Toronto, Canada";
      location!.dispatchEvent(new Event("input", { bubbles: true }));
      // Still typing: nothing saved yet, and further keystrokes restart the clock.
      expect(saved).toHaveLength(0);
      vi.advanceTimersByTime(500);
      location!.dispatchEvent(new Event("input", { bubbles: true }));
      vi.advanceTimersByTime(500);
      expect(saved).toHaveLength(0);
      vi.advanceTimersByTime(300);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.profile?.location).toBe("Toronto, Canada");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not autosave the add-member form, which would create half-typed records", () => {
    vi.useFakeTimers();
    try {
      const saved: AdminBotLabMemberSaveInput[] = [];
      const container = renderToDiv(
        baseProps({ mode: "admin", onSaveMember: (input) => saved.push(input) }),
      );
      const idInput = container.querySelector<HTMLInputElement>(
        '#adminbot-add-member input[name="id"]',
      );
      idInput!.value = "pa";
      idInput!.dispatchEvent(new Event("input", { bubbles: true }));
      vi.advanceTimersByTime(2000);
      expect(saved).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("renderAdminBot members panel — view as", () => {
  const roster: AdminBotLabMember[] = [
    ...members,
    member({ id: "ada", name: "Ada Lovelace", email: "ada@lab.co", privilege_level: "member" }),
  ];

  function draw(overrides: Partial<AdminBotProps> = {}) {
    return renderToDiv(
      baseProps({
        mode: "admin",
        signedInMemberId: "pat",
        data: { ...createEmptyAdminBotDashboardData(), members: roster, loadedAt: Date.now() },
        ...overrides,
      }),
    );
  }

  function viewAsButtons(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>("tbody tr button")].filter(
      (button) => button.textContent?.trim() === "View as",
    );
  }

  it("offers the action on other members' rows only", () => {
    const container = draw({ onViewAsMember: () => undefined });
    const buttons = viewAsButtons(container);
    // One button, on Ada's row -- viewing as yourself is the one case the service refuses outright,
    // so the row that would do it does not offer it.
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.closest("tr")?.textContent).toContain("Ada Lovelace");
  });

  it("hands back the member whose row was clicked", () => {
    const clicked: string[] = [];
    const container = draw({ onViewAsMember: (entry) => clicked.push(entry.id) });
    viewAsButtons(container)[0]?.click();
    expect(clicked).toEqual(["ada"]);
  });

  it("leaves the action off the page entirely when the host cannot open one", () => {
    // No callback is how a non-admin -- or an admin already inside somebody else's view -- sees
    // this panel. Absent rather than disabled: a button that cannot act is a question the page
    // has no way to answer.
    expect(viewAsButtons(draw())).toHaveLength(0);
  });
});

describe("renderAdminBot members panel — edit history", () => {
  it("opens one member's history from their row and fetches it on the click", () => {
    const asked: Array<[string, string]> = [];
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        onLoadRecentEdits: (subject, id) => asked.push([subject, id]),
      }),
    );
    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="member-edits-open-pat"]',
    );
    expect(open).not.toBeNull();
    // The popover it points at is the one carrying that member's rows, not a shared panel.
    expect(open?.getAttribute("popovertarget")).toBe(
      container.querySelector('[data-testid="member-edits-pat"]')?.id,
    );
    // Nothing is asked for until somebody asks: forty histories nobody opened is the cost this
    // avoids.
    expect(asked).toEqual([]);
    open?.click();
    expect(asked).toEqual([["member", "pat"]]);
  });

  it("shows the loaded rows, naming the actor rather than the member", () => {
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        onLoadRecentEdits: () => undefined,
        recentEdits: {
          "member:pat": {
            loading: false,
            error: null,
            updates: [
              {
                slot_id: "member:pat:role",
                subject: "member",
                field_key: "role",
                actor_member_id: "sam",
                actor_name: "Sam Lee",
                source: "admin",
                at: "2026-09-01T10:00:00Z",
              },
            ],
          },
        },
      }),
    );
    const panel = container.querySelector('[data-testid="member-edits-pat"]');
    expect(panel?.querySelector(".recent-edits__actor")?.textContent).toBe("Sam Lee");
    expect(panel?.querySelector('[data-testid="recent-edits-empty"]')).toBeNull();
  });

  it("keeps the history out of the general roster, where the row is not an admin's to read", () => {
    const container = renderToDiv(
      baseProps({ mode: "general", onLoadRecentEdits: () => undefined }),
    );
    expect(container.querySelector('[data-testid="member-edits-open-pat"]')).toBeNull();
    expect(container.querySelector('[data-testid="member-edits-pat"]')).toBeNull();
  });
});

describe("renderAdminBot papers panel — conference travel", () => {
  const roster = {
    key: "emnlp:2026",
    venue: "EMNLP",
    year: 2026,
    label: "EMNLP 2026",
    paper_count: 2,
    going_count: 1,
    unanswered_count: 1,
    people: [
      {
        attendee_key: "member:ada",
        member_id: "ada",
        name: "Ada Lovelace",
        attending: "yes" as const,
        papers: [
          { paper_id: "p1", title: "Causal abstraction", attending: "yes" as const },
          { paper_id: "p2", title: "Robustness bounds", attending: "unknown" as const },
        ],
      },
      {
        attendee_key: "name:jo-park",
        name: "Jo Park",
        attending: "unknown" as const,
        papers: [{ paper_id: "p2", title: "Robustness bounds", attending: "unknown" as const }],
      },
    ],
    papers_awaiting: [{ paper_id: "p2", title: "Robustness bounds", unanswered: 1 }],
  };

  function withRoster() {
    return renderToDiv(
      baseProps({
        mode: "admin",
        panel: "papers",
        data: { ...createEmptyAdminBotDashboardData(), members, conferenceRosters: [roster] },
      }),
    );
  }

  it("names everyone at the conference, not only the people who said yes", () => {
    const container = withRoster();
    const ada = container.querySelector(
      '[data-testid="travel-board-person-emnlp:2026-member:ada"]',
    );
    const jo = container.querySelector(
      '[data-testid="travel-board-person-emnlp:2026-name:jo-park"]',
    );
    expect(ada?.textContent).toContain("Ada Lovelace");
    expect(ada?.textContent).toContain("Going");
    // The whole point of the board: an unanswered person is a name to chase, not a count.
    expect(jo?.textContent).toContain("Jo Park");
    expect(jo?.textContent).toContain("No answer yet");
  });

  it("carries the year, so two years of the same conference cannot merge", () => {
    const section = withRoster().querySelector(
      '[data-testid="travel-board-conference-emnlp:2026"]',
    );
    expect(section?.textContent).toContain("EMNLP 2026");
  });

  it("names the papers still owing an answer", () => {
    expect(withRoster().textContent).toContain("Robustness bounds (1)");
  });

  it("renders nothing when the service returned no conferences", () => {
    const container = renderToDiv(
      baseProps({
        mode: "admin",
        panel: "papers",
        data: { ...createEmptyAdminBotDashboardData(), members },
      }),
    );
    expect(container.querySelector('[data-testid="travel-board"]')).toBeNull();
  });
});

describe("pending actions bulk clear", () => {
  function proposal(id: string, summary: string) {
    return {
      id,
      type: "slack.send_message",
      risk_tier: "T3" as const,
      summary,
      status: "pending" as const,
      payload_hash: `hash_${id}`,
      approval_requirement: { requires_approval: true, approver_roles: ["pi"], min_approvals: 1 },
      approvals: [],
      created_at: "2026-07-14T19:00:00.000Z",
      updated_at: "2026-07-14T19:00:00.000Z",
    };
  }

  const proposals = [proposal("act_one", "First thing"), proposal("act_two", "Second thing")];

  function drawActions(overrides: Partial<AdminBotProps> = {}) {
    const container = document.createElement("div");
    render(
      renderAdminBot(
        baseProps({
          panel: "actions",
          mode: "admin",
          data: { ...createEmptyAdminBotDashboardData(), proposals, loadedAt: Date.now() },
          ...overrides,
        }),
      ),
      container,
    );
    return container;
  }

  it("offers one checkbox per proposal plus a select-all", () => {
    const host = drawActions();
    expect(host.querySelectorAll(".adminbot-action__select input").length).toBe(2);
    expect(host.querySelector(".adminbot-action-bulk__all")?.textContent).toContain("Select all 2");
  });

  it("keeps the remove button disabled until something is ticked", () => {
    const idle = drawActions().querySelector<HTMLButtonElement>(".adminbot-action-bulk button");
    expect(idle?.disabled).toBe(true);

    const armed = drawActions({ selectedActionIds: ["act_one"] }).querySelector<HTMLButtonElement>(
      ".adminbot-action-bulk button",
    );
    expect(armed?.disabled).toBe(false);
    expect(armed?.textContent).toContain("(1)");
  });

  it("reports a partial selection and reflects it on the select-all box", () => {
    const host = drawActions({ selectedActionIds: ["act_one"] });
    expect(host.querySelector(".adminbot-action-bulk__all")?.textContent).toContain("1 of 2");
    const all = host.querySelector<HTMLInputElement>(".adminbot-action-bulk__all input");
    expect(all?.indeterminate).toBe(true);
    expect(all?.checked).toBe(false);
  });

  it("select-all hands back every id, and hands back nothing once all are ticked", () => {
    const seen: string[][] = [];
    const none = drawActions({ onSetSelectedActions: (ids) => seen.push(ids) });
    none
      .querySelector<HTMLInputElement>(".adminbot-action-bulk__all input")
      ?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen[0]).toEqual(["act_one", "act_two"]);

    const all = drawActions({
      selectedActionIds: ["act_one", "act_two"],
      onSetSelectedActions: (ids) => seen.push(ids),
    });
    all
      .querySelector<HTMLInputElement>(".adminbot-action-bulk__all input")
      ?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen[1]).toEqual([]);
  });

  it("ticking a row toggles just that proposal", () => {
    const toggled: string[] = [];
    const host = drawActions({ onToggleActionSelected: (id) => toggled.push(id) });
    host
      .querySelectorAll<HTMLInputElement>(".adminbot-action__select input")[1]
      ?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toggled).toEqual(["act_two"]);
  });

  // The whole point of the asymmetry: a bulk clear is a tidy-up, a bulk execute would be N
  // irreversible external effects behind one click. There must be no way to ask for the latter.
  it("offers no bulk execute", () => {
    const bar = drawActions({ selectedActionIds: ["act_one", "act_two"] }).querySelector(
      ".adminbot-action-bulk",
    );
    expect(bar?.textContent).toContain("Remove selected");
    expect(bar?.textContent?.toLowerCase()).not.toContain("execute");
  });

  it("freezes the per-row buttons while a bulk clear is running", () => {
    const host = drawActions({ selectedActionIds: ["act_one"], bulkActionBusy: true });
    const rowButtons = host.querySelectorAll<HTMLButtonElement>(".adminbot-action__actions button");
    expect(rowButtons.length).toBe(4);
    for (const button of rowButtons) {
      expect(button.disabled).toBe(true);
    }
    expect(
      host.querySelector<HTMLButtonElement>(".adminbot-action-bulk button")?.textContent,
    ).toContain("Removing");
  });
});
