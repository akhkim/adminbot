import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { LabMember, MemberProfileUpdate } from "../auth/session.ts";
import { renderProfile } from "./profile.ts";

function createMember(overrides: Partial<LabMember> = {}): LabMember {
  return {
    id: "pat",
    name: "Pat Doe",
    email: "pat@example.com",
    role: "Researcher",
    affiliation: "Lab",
    location: "Remote",
    timezone: "UTC",
    slack_user_id: "U123",
    hours_per_week: 10,
    research_topics: ["nlp"],
    projects: ["adminbot"],
    ...overrides,
  };
}

function createState(member: LabMember, overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "profile",
    memberId: member.id,
    adminBotData: { members: [member] },
    adminBotOnboarding: null,
    adminBotNotice: null,
    profileEditingSection: "basics",
    profileAccountChecks: {},
    ...overrides,
  } as unknown as AppViewState;
}

function renderPage(
  state: AppViewState,
  onSave: (memberId: string, fields: MemberProfileUpdate) => void,
): HTMLElement {
  const container = document.createElement("div");
  render(renderProfile(state, { onSave }), container);
  return container;
}

describe("renderProfile autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves basics fields on their own, without a Save button click", () => {
    const member = createMember();
    const state = createState(member);
    const onSave = vi.fn();
    const container = renderPage(state, onSave);

    const nameInput = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    nameInput.value = "Pat Updated";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Not saved yet -- still inside the debounce window.
    expect(onSave).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("pat", expect.objectContaining({ name: "Pat Updated" }));

    // No explicit "Save" submit button remains in the form.
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it("flushes the pending save immediately when focus leaves the form", () => {
    const member = createMember();
    const state = createState(member);
    const onSave = vi.fn();
    const container = renderPage(state, onSave);

    const form = container.querySelector("form.profile__form")!;
    const nameInput = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    nameInput.value = "Pat Updated";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSave).not.toHaveBeenCalled();

    form.dispatchEvent(new FocusEvent("focusout", { bubbles: false, relatedTarget: null }));

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows an auto-dismissing 'Update saved' toast once the save completes", () => {
    const member = createMember();
    const state = createState(member, {
      adminBotNotice: { kind: "success", text: "Saved your profile." },
    });
    const container = renderPage(state, vi.fn());

    const toast = container.querySelector('[data-testid="profile-save-toast"]');
    expect(toast?.textContent?.trim()).toBe("Update saved");

    vi.advanceTimersByTime(3000);
    render(renderProfile(state, { onSave: vi.fn() }), container);

    expect(state.adminBotNotice).toBeNull();
  });

  it("flags a GitHub handle that doesn't exist, without blocking the save", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const member = createMember();
      const state = createState(member);
      const onSave = vi.fn();
      const container = renderPage(state, onSave);

      const githubInput = container.querySelector<HTMLInputElement>('input[name="github_url"]')!;
      githubInput.value = "https://github.com/this-handle-should-not-exist-zzz";
      githubInput.dispatchEvent(new Event("input", { bubbles: true }));

      await vi.advanceTimersByTimeAsync(1000);

      // The save still goes through -- a liveness miss is a warning, not a rejection.
      expect(onSave).toHaveBeenCalledWith(
        "pat",
        expect.objectContaining({ github_url: "https://github.com/this-handle-should-not-exist-zzz" }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/users/this-handle-should-not-exist-zzz",
        expect.anything(),
      );
      expect(state.profileAccountChecks.github_url?.status).toBe("not-found");

      render(renderProfile(state, { onSave }), container);
      const status = container.querySelector('[data-testid="profile-account-check-github_url"]');
      expect(status?.textContent).toContain("this-handle-should-not-exist-zzz");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("confirms a GitHub handle that does exist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const member = createMember();
      const state = createState(member);
      const container = renderPage(state, vi.fn());

      const githubInput = container.querySelector<HTMLInputElement>('input[name="github_url"]')!;
      githubInput.value = "https://github.com/octocat";
      githubInput.dispatchEvent(new Event("input", { bubbles: true }));

      await vi.advanceTimersByTimeAsync(1000);

      expect(state.profileAccountChecks.github_url?.status).toBe("verified");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("renderProfile mandatory fields", () => {
  it("marks a mandatory field with a star but leaves an optional one unmarked", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const nameRow = container
      .querySelector('input[name="name"]')
      ?.closest(".profile__form-row");
    expect(nameRow?.querySelector(".profile__mandatory")).not.toBeNull();

    const websiteRow = container
      .querySelector('input[name="personal_website"]')
      ?.closest(".profile__form-row");
    expect(websiteRow?.querySelector(".profile__mandatory")).toBeNull();
    expect(websiteRow?.querySelector(".profile__optional")).not.toBeNull();
  });

  it("lets the member close the editor with mandatory fields still blank", () => {
    const member = createMember({ role: "", affiliation: "" });
    const state = createState(member);
    const onSave = vi.fn();
    const container = renderPage(state, onSave);

    container
      .querySelector<HTMLButtonElement>('[data-testid="profile-basics"] .btn.primary')!
      .click();

    // Closing flushes whatever is on the form -- including the blanks -- but never blocks it.
    expect(state.profileEditingSection).toBeNull();
    expect(onSave).toHaveBeenCalledWith(
      "pat",
      expect.objectContaining({ role: "", affiliation: "" }),
    );
  });

  it("marks every field in the blanks form, since only mandatory fields ever appear there", () => {
    const member = createMember({ role: "", location: "" });
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const blanksSection = container.querySelector('[data-testid="profile-blanks"]')!;
    const stars = blanksSection.querySelectorAll(".profile__mandatory");
    const rows = blanksSection.querySelectorAll(".profile__form-row");
    expect(stars.length).toBe(rows.length);
    expect(stars.length).toBeGreaterThan(0);
  });
});

describe("renderProfile field types", () => {
  it("renders role as a dropdown restricted to the closed role list", () => {
    const member = createMember({ role: "" });
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const select = container.querySelector<HTMLSelectElement>('select[name="role"]')!;
    expect(select).not.toBeNull();
    const options = [...select.options].map((option) => option.value).filter(Boolean);
    expect(options.length).toBeGreaterThan(0);
    // Nothing outside the closed vocabulary is offered.
    expect(options).not.toContain("Definitely Not A Real Role");
  });

  it("renders timezone as a dropdown and notes as a paragraph textarea", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(container.querySelector('select[name="timezone"]')).not.toBeNull();
    expect(container.querySelector('textarea[name="notes"]')).not.toBeNull();
  });

  it("renders hours_per_week as a numeric input and github_url as a url input", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(
      container.querySelector<HTMLInputElement>('input[name="hours_per_week"]')?.type,
    ).toBe("number");
    expect(container.querySelector<HTMLInputElement>('input[name="github_url"]')?.type).toBe(
      "url",
    );
  });

  it("offers a calendar email field distinct from the governed directory email", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(container.querySelector('input[name="calendar_email"]')).not.toBeNull();
    // The directory email itself has no input -- it is locked, not part of this form.
    expect(container.querySelector('input[name="email"]')).toBeNull();
  });

  it("does not show status or privilege level to the member", () => {
    const member = createMember({ status: "active", privilege_level: "admin" } as Partial<
      LabMember & { status: string; privilege_level: string }
    >);
    const state = createState(member, { profileEditingSection: null });
    const container = renderPage(state, vi.fn());

    expect(container.textContent).not.toContain("active");
    expect(container.querySelector('[data-testid="profile-basics"]')?.textContent).not.toMatch(
      /privilege/i,
    );
  });
});

describe("renderProfile visual structure", () => {
  it("clusters editable fields into labeled groups instead of one flat list", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    const groupTitles = [...basics.querySelectorAll(".profile__group-title")].map((el) =>
      el.textContent?.trim(),
    );
    expect(groupTitles.length).toBeGreaterThan(1);
    // github_url (a "Links" field) must land inside a group, not floating at the top level.
    const githubInput = container.querySelector('input[name="github_url"]')!;
    expect(githubInput.closest(".profile__field-group")).not.toBeNull();
    expect(githubInput.closest(".profile__field-group")?.querySelector(".profile__group-title")
      ?.textContent).toContain("Links");
  });

  it("groups the read-only view the same way as the edit form", () => {
    const member = createMember();
    const state = createState(member, { profileEditingSection: null });
    const container = renderPage(state, vi.fn());

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    const groups = [...basics.querySelectorAll(".profile__field-group")];
    expect(groups.length).toBeGreaterThan(1);
    // The locked directory email still renders, now inside its own "Account" group.
    const accountGroup = groups.find((group) =>
      group.querySelector(".profile__group-title")?.textContent?.includes("Account"),
    );
    expect(accountGroup?.textContent).toContain("pat@example.com");
  });

  it("shows badges and a completeness indicator in the identity header", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const hero = container.querySelector(".profile__hero")!;
    expect(hero).not.toBeNull();
    expect(hero.querySelector('[data-testid="profile-badges"]')).not.toBeNull();
    expect(hero.querySelector(".profile__completeness-percent")?.textContent).toMatch(/^\d+%$/);
  });

  it("only shows the fill-in-the-blanks card as highlighted, not every section", () => {
    const member = createMember({ role: "" });
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(
      container.querySelector('[data-testid="profile-blanks"]')?.classList.contains(
        "profile__section--highlight",
      ),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="profile-basics"]')?.classList.contains(
        "profile__section--highlight",
      ),
    ).toBe(false);
  });
});
