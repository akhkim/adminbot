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
        expect.objectContaining({
          github_url: "https://github.com/this-handle-should-not-exist-zzz",
        }),
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

    const nameRow = container.querySelector('input[name="name"]')?.closest(".profile__form-row");
    expect(nameRow?.querySelector(".profile__mandatory")).not.toBeNull();

    const websiteRow = container
      .querySelector('input[name="personal_website"]')
      ?.closest(".profile__form-row");
    expect(websiteRow?.querySelector(".profile__mandatory")).toBeNull();
    expect(websiteRow?.querySelector(".profile__optional")).not.toBeNull();
  });

  it("marks every mandatory field and leaves the optional ones unmarked", () => {
    const member = createMember({ role: "", location: "" });
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    const marks = basics.querySelectorAll(".profile__mandatory");
    const optional = basics.querySelectorAll(".profile__optional");
    expect(marks.length).toBeGreaterThan(0);
    expect(optional.length).toBeGreaterThan(0);
    // Every field is on the page now, so the two sets together account for all of them.
    expect(marks.length + optional.length).toBe(
      basics.querySelectorAll(".profile__form-row").length,
    );
  });
});

describe("renderProfile onboarding suggestions", () => {
  const step = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: `Step ${id}`,
    status,
    category: "Getting started",
    required: true,
    ...extra,
  });

  it("lists the onboarding steps the member has not finished yet", () => {
    const member = createMember();
    const state = createState(member, {
      adminBotOnboarding: {
        current_step: step("linkedin", "current", {
          detail: "Add the lab to your profile.",
          links: [{ label: "Open LinkedIn", url: "https://linkedin.com" }],
        }),
        remaining: [step("gpu", "remaining")],
        completed: [step("calendar", "complete")],
        steps: [],
      },
    } as unknown as Partial<AppViewState>);

    const container = renderPage(state, vi.fn());
    const suggestions = container.querySelector('[data-testid="profile-suggestions"]')!;

    expect(
      suggestions.querySelector('[data-testid="suggestion-onboarding-linkedin"]'),
    ).not.toBeNull();
    expect(suggestions.querySelector('[data-testid="suggestion-onboarding-gpu"]')).not.toBeNull();
    // A finished step is not outstanding, so it is not advice.
    expect(suggestions.querySelector('[data-testid="suggestion-onboarding-calendar"]')).toBeNull();
  });

  it("carries each step's own status, detail and link through from the checklist", () => {
    const member = createMember();
    const state = createState(member, {
      adminBotOnboarding: {
        current_step: step("linkedin", "current", {
          detail: "Add the lab to your profile.",
          links: [{ label: "Open LinkedIn", url: "https://linkedin.com" }],
        }),
        remaining: [],
        completed: [],
        steps: [],
      },
    } as unknown as Partial<AppViewState>);

    const container = renderPage(state, vi.fn());
    const card = container.querySelector('[data-testid="suggestion-onboarding-linkedin"]')!;

    expect(card.querySelector(".profile-suggestion__title")?.textContent).toContain(
      "Step linkedin",
    );
    expect(card.querySelector(".profile-suggestion__status")?.textContent?.trim()).toBe(
      "Start here",
    );
    expect(card.querySelector(".profile-suggestion__body")?.textContent?.trim()).toBe(
      "Add the lab to your profile.",
    );
    const link = card.querySelector<HTMLAnchorElement>(".profile-suggestion__link");
    expect(link?.getAttribute("href")).toBe("https://linkedin.com");
    expect(link?.textContent).toContain("Open LinkedIn");
  });

  it("renders a step that carries no link or detail without an empty link stub", () => {
    const member = createMember();
    const state = createState(member, {
      adminBotOnboarding: {
        remaining: [step("gpu", "remaining")],
        completed: [],
        steps: [],
      },
    } as unknown as Partial<AppViewState>);

    const container = renderPage(state, vi.fn());
    const card = container.querySelector('[data-testid="suggestion-onboarding-gpu"]')!;

    expect(card.querySelector(".profile-suggestion__link")).toBeNull();
    expect(card.querySelector(".profile-suggestion__body")).toBeNull();
    expect(card.querySelector(".profile-suggestion__status")?.textContent?.trim()).toBe("To do");
  });
});

describe("renderProfile LinkedIn URN and intake form", () => {
  it("offers the URN collector until the field is filled, then stops", () => {
    const without = renderPage(createState(createMember()), vi.fn());
    const card = without.querySelector('[data-testid="suggestion-linkedin-urn"]')!;
    expect(card).not.toBeNull();
    expect(card.querySelector<HTMLAnchorElement>(".profile-suggestion__link")?.href).toBe(
      "https://linkedin-urn-collector.vercel.app/",
    );

    const filled = renderPage(
      createState(createMember({ linkedin_urn: "ACoAAB1234567" } as Partial<LabMember>)),
      vi.fn(),
    );
    expect(filled.querySelector('[data-testid="suggestion-linkedin-urn"]')).toBeNull();
  });

  it("marks the URN required, matching the reminder the service already sends", () => {
    const container = renderPage(createState(createMember()), vi.fn());
    const input = container.querySelector<HTMLInputElement>('input[name="linkedin_urn"]');
    expect(input).not.toBeNull();
    // MANDATORY_PROFILE_FIELDS in extensions/adminbot/src/kernel/service.ts counts it, so the
    // Slack nudge chases it either way. Marking it optional here just hid that from the member.
    const row = input?.closest(".profile__form-row");
    expect(row?.querySelector(".profile__mandatory")).not.toBeNull();
    expect(row?.querySelector(".profile__optional")).toBeNull();
  });

  // Time zone is the one field derivable from another the member already filled in, so the control
  // opens on a guess rather than on an empty 400-entry dropdown. See data/timezone-for-location.ts.
  describe("time zone prefill", () => {
    it("preselects a zone inferred from the location when none is stored", () => {
      const container = renderPage(
        createState(
          createMember({ location: "Pittsburgh, PA", timezone: "" } as Partial<LabMember>),
        ),
        vi.fn(),
      );
      const select = container.querySelector<HTMLSelectElement>('select[name="timezone"]');
      expect(select?.value).toBe("America/New_York");
      // And says where the value came from, so a wrong guess is visible before it is saved.
      const hint = container.querySelector('[data-testid="profile-timezone-prefill"]');
      expect(hint?.textContent).toContain("America/New_York");
      expect(hint?.textContent).toContain("Pittsburgh, PA");
    });

    it("leaves a stored zone alone and says nothing about it", () => {
      const container = renderPage(
        createState(
          createMember({
            location: "Pittsburgh, PA",
            timezone: "Europe/Zurich",
          } as Partial<LabMember>),
        ),
        vi.fn(),
      );
      const select = container.querySelector<HTMLSelectElement>('select[name="timezone"]');
      expect(select?.value).toBe("Europe/Zurich");
      expect(container.querySelector('[data-testid="profile-timezone-prefill"]')).toBeNull();
    });

    it("leaves the control empty when the location means nothing to it", () => {
      const container = renderPage(
        createState(
          createMember({ location: "somewhere nice", timezone: "" } as Partial<LabMember>),
        ),
        vi.fn(),
      );
      expect(container.querySelector<HTMLSelectElement>('select[name="timezone"]')?.value).toBe("");
      expect(container.querySelector('[data-testid="profile-timezone-prefill"]')).toBeNull();
    });

    // The guess reaches the record through the same autosave as anything the member typed, so it
    // is never a silent write -- but it does stick once they touch the form.
    it("commits the guess with the next autosave", () => {
      const onSave = vi.fn();
      const container = renderPage(
        createState(createMember({ location: "Toronto", timezone: "" } as Partial<LabMember>)),
        onSave,
      );
      const form = container.querySelector<HTMLFormElement>(".profile__form");
      form?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(onSave).toHaveBeenCalled();
      expect(onSave.mock.calls.at(-1)?.[1].timezone).toBe("America/Toronto");
    });
  });

  // It is the member's own answers, not the lab's blank form. Google Forms only ever hands the
  // edit link to the respondent, so nobody else can produce it for them -- which is why this is a
  // field they paste into rather than a link the profile could render.
  it("collects the member's own application form URL as a field, not a shared link", () => {
    const complete = createMember({
      linkedin_urn: "ACoAAB1234567",
      personal_website: "https://ada.dev",
      research_topics: ["gpu scheduling"],
    } as Partial<LabMember>);
    const container = renderPage(createState(complete), vi.fn());

    expect(container.querySelector('[data-testid="suggestion-intake-form"]')).toBeNull();

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    const input = basics.querySelector<HTMLInputElement>('[name="intake_form_url"]');
    expect(input).not.toBeNull();
    // Optional, and in the links group beside the other places a member's details live.
    const row = input?.closest(".profile__form-row");
    expect(row?.querySelector(".profile__optional")).not.toBeNull();
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

  it("renders timezone as a dropdown, and carries no free-text notes field", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(container.querySelector('select[name="timezone"]')).not.toBeNull();
    // "Any other notes" is deliberately not carried onto the profile from the member sheet.
    expect(container.querySelector('textarea[name="notes"]')).toBeNull();
  });

  it("renders hours_per_week as a numeric input and github_url as a url input", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(container.querySelector<HTMLInputElement>('input[name="hours_per_week"]')?.type).toBe(
      "number",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="github_url"]')?.type).toBe("url");
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
    expect(
      githubInput.closest(".profile__field-group")?.querySelector(".profile__group-title")
        ?.textContent,
    ).toContain("Links");
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

  it("edits the record in place, with no edit button and no separate blanks card", () => {
    const member = createMember({ role: "", location: "" });
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    // The record is editable on arrival: no click stands between the member and a correction.
    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    expect(basics.querySelector('input[name="name"]')).not.toBeNull();
    expect(basics.querySelector('select[name="role"]')).not.toBeNull();

    // The edit affordance and the duplicate fill-in-the-blanks form are both gone.
    expect(container.querySelector('[data-testid="profile-basics-edit"]')).toBeNull();
    expect(container.querySelector('[data-testid="profile-blanks"]')).toBeNull();
    expect(basics.querySelector(".btn.primary")).toBeNull();
  });

  it("keeps the governed fields read-only inside the always-editable record", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    // Email is the lab's to set: it renders as a locked row, never as an input to type into.
    expect(basics.querySelector('input[name="email"]')).toBeNull();
    expect(basics.querySelector(".profile-field--locked")?.textContent).toContain(
      "pat@example.com",
    );
  });
});
