import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminBotMandatoryProfileFields } from "../../../../../extensions/adminbot/src/contracts/actions.js";
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
  render(
    renderProfile(state, {
      onSave,
      onPolishPhoto: vi.fn(),
      onApplyPolishedPhoto: vi.fn(),
    }),
    container,
  );
  return container;
}

// The country box is a custom element, and a custom element only upgrades once it is in the
// document -- rendering into a detached div leaves it inert. Tests that read or drive that control
// mount the page for real and wait for its first update.
async function renderMountedPage(
  state: AppViewState,
  onSave: (memberId: string, fields: MemberProfileUpdate) => void,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderProfile(state, { onSave }), container);
  const countrySelect = container.querySelector("adminbot-country-select") as
    | (HTMLElement & { updateComplete?: Promise<unknown> })
    | null;
  await countrySelect?.updateComplete;
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

  // The record keeps one phone string; the form offers a country picker plus the local number, so
  // the two have to fold back together on save and split apart again on render.
  it("saves the picked country code and the typed number as one whatsapp value", async () => {
    const state = createState(createMember({ whatsapp: "" } as Partial<LabMember>));
    const onSave = vi.fn();
    const container = await renderMountedPage(state, onSave);

    const code = container.querySelector<HTMLInputElement>('input[name="whatsapp__dial"]')!;
    const number = container.querySelector<HTMLInputElement>('input[name="whatsapp"]')!;
    code.value = "+44 United Kingdom";
    number.value = "7700 900123";
    number.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(1000);

    expect(onSave).toHaveBeenCalledWith(
      "pat",
      expect.objectContaining({ whatsapp: "+44 7700 900123" }),
    );
  });

  // The country box is free text with a suggestion list, so a member can leave it holding a bare
  // code or a country name they typed without picking. All three resolve to the same stored value.
  it("accepts a bare code or a typed country name in the country box", async () => {
    for (const typed of ["+44", "44", "united kingdom"]) {
      const onSave = vi.fn();
      const container = await renderMountedPage(
        createState(createMember({ whatsapp: "" } as Partial<LabMember>)),
        onSave,
      );

      const code = container.querySelector<HTMLInputElement>('input[name="whatsapp__dial"]')!;
      const number = container.querySelector<HTMLInputElement>('input[name="whatsapp"]')!;
      code.value = typed;
      number.value = "7700 900123";
      number.dispatchEvent(new Event("input", { bubbles: true }));
      vi.advanceTimersByTime(1000);

      expect(onSave).toHaveBeenCalledWith(
        "pat",
        expect.objectContaining({ whatsapp: "+44 7700 900123" }),
      );
    }
  });

  // An example sitting in an empty box reads as somebody else's answer already on file, so every
  // placeholder says it is one.
  it("labels every example placeholder as an example", () => {
    const container = renderPage(createState(createMember()), vi.fn());

    // The country box is excluded: its placeholder names the box ("Code") rather than showing an
    // example answer, because the suggestion list is where its answers come from.
    const placeheld = [
      ...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "[placeholder]:not(.profile__phone-code)",
      ),
    ];
    expect(placeheld.length).toBeGreaterThan(0);
    for (const control of placeheld) {
      expect(control.placeholder.startsWith("ex. ")).toBe(true);
    }
  });

  it("reopens a stored number with its country already filled in", async () => {
    const container = await renderMountedPage(
      createState(createMember({ whatsapp: "+91 98765 43210" } as Partial<LabMember>)),
      vi.fn(),
    );

    const code = container.querySelector<HTMLInputElement>('input[name="whatsapp__dial"]')!;
    const number = container.querySelector<HTMLInputElement>('input[name="whatsapp"]')!;
    // Named, not just coded, so the box says which country it means.
    expect(code.value).toBe("+91 India");
    expect(number.value).toBe("98765 43210");
  });

  // Typing a country name has to narrow the list: it is the reason this control is not a <select>,
  // whose type-ahead only matches the dial code the option text starts with.
  it("filters the country list by name, dial code, or ISO code", async () => {
    const container = await renderMountedPage(
      createState(createMember({ whatsapp: "" } as Partial<LabMember>)),
      vi.fn(),
    );
    const element = container.querySelector("adminbot-country-select") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    const code = container.querySelector<HTMLInputElement>('input[name="whatsapp__dial"]')!;

    const optionsFor = async (typed: string) => {
      code.focus();
      code.value = typed;
      code.dispatchEvent(new Event("input", { bubbles: true }));
      await element.updateComplete;
      return [...container.querySelectorAll(".country-select__option")].map((option) =>
        option.textContent?.replace(/\s+/gu, " ").trim(),
      );
    };

    expect(await optionsFor("canad")).toEqual(["+1 Canada"]);
    expect(await optionsFor("+353")).toEqual(["+353 Ireland"]);
    expect(await optionsFor("jp")).toEqual(["+81 Japan"]);

    // Typing scheduled an autosave on the module-level timer these tests share; let it fire here
    // rather than leaving it to flush inside whichever test runs next.
    vi.advanceTimersByTime(1000);
  });

  // Leaving a form nobody edited used to fire a full-record PUT, a "saved" toast for a save that
  // changed nothing, and an outbound account check per checkable field.
  it("saves nothing when focus leaves a form that was never edited", () => {
    const state = createState(createMember());
    const onSave = vi.fn();
    const container = renderPage(state, onSave);

    const form = container.querySelector("form.profile__form")!;
    form.dispatchEvent(new FocusEvent("focusout", { bubbles: false, relatedTarget: null }));

    expect(onSave).not.toHaveBeenCalled();
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
    render(
      renderProfile(state, {
        onSave: vi.fn(),
        onPolishPhoto: vi.fn(),
        onApplyPolishedPhoto: vi.fn(),
      }),
      container,
    );

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

      render(
        renderProfile(state, {
          onSave,
          onPolishPhoto: vi.fn(),
          onApplyPolishedPhoto: vi.fn(),
        }),
        container,
      );
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
  it("marks a blank mandatory field but leaves an optional one unmarked", () => {
    const member = createMember({ name: "" });
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

  // The mark chases what is still missing, so answering a required field clears it. Otherwise a
  // fully filled profile would still show a page of dots saying nothing.
  // The mark says the field is required, not that it is empty -- so it stays once answered, and a
  // member can see at a glance which boxes they must not clear.
  it("keeps the mark once a mandatory field is answered", () => {
    const container = renderPage(createState(createMember({ name: "Pat Doe" })), vi.fn());

    const nameRow = container.querySelector('input[name="name"]')?.closest(".profile__form-row");
    expect(nameRow?.querySelector(".profile__mandatory")).not.toBeNull();
  });

  it("labels every unmarked, non-mandatory field optional", () => {
    const member = createMember({ role: "", location: "" });
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    const rows = [...basics.querySelectorAll(".profile__form-row")];
    const optional = basics.querySelectorAll(".profile__optional");
    expect(optional.length).toBeGreaterThan(0);
    // Nothing carries both marks, and no row is left without either a dot or an "(optional)".
    for (const row of rows) {
      const dot = row.querySelector(".profile__mandatory");
      const opt = row.querySelector(".profile__optional");
      expect(Boolean(dot && opt)).toBe(false);
    }
    const answeredMandatory = rows.filter(
      (row) => !row.querySelector(".profile__mandatory") && !row.querySelector(".profile__optional"),
    );
    for (const row of answeredMandatory) {
      expect(row.querySelector<HTMLInputElement>("[name]")?.value).toBeTruthy();
    }
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

  // The photo rules are their own section, after the record: reference a member reads once plus a
  // real action, which is more than a suggestion card carries -- but still behind the fields the
  // page exists for.
  it("shows the Slack photo guideline as its own section after basic info", () => {
    const container = renderPage(createState(createMember()), vi.fn());

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    const guidelines = container.querySelector('[data-testid="profile-photo-guidelines"]')!;
    expect(guidelines).not.toBeNull();
    expect(guidelines.tagName).toBe("SECTION");
    // After the record, and outside the suggestions stack.
    expect(basics.compareDocumentPosition(guidelines) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const suggestions = container.querySelector('[data-testid="profile-suggestions"]');
    expect(suggestions?.contains(guidelines) ?? false).toBe(false);
  });

  // The guidelines are a note every member can read, not the result of a check that chases them:
  // the review pass is deliberately unscheduled, so "no assessment" is the ordinary state and must
  // not render as a verdict still pending.
  it("reads as guidance for a member no photo review has ever looked at", () => {
    const container = renderPage(createState(createMember()), vi.fn());
    const guidelines = container.querySelector('[data-testid="profile-photo-guidelines"]')!;

    // The rules themselves are always there to read.
    expect(guidelines.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
    expect(guidelines.textContent).toContain("Face clearly visible");
    // ...and the polish control that acts on them.
    expect(guidelines.querySelector("button")).not.toBeNull();
    // No dangling pending-check line, and no verdict language.
    expect(guidelines.textContent).not.toContain("No automated check");
    expect(guidelines.textContent).not.toContain("Needs update");
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
  // The collector link sits on the field it feeds rather than in a card elsewhere on the page, and
  // it stays there once the field is filled: a hand-off that vanishes on completion leaves anyone
  // correcting a wrong value with nowhere to go.
  it("puts the URN collector link on the field itself, filled or not", () => {
    const linkIn = (container: HTMLElement) =>
      container.querySelector<HTMLAnchorElement>('[data-testid="profile-urn-collector"]');

    const without = renderPage(createState(createMember()), vi.fn());
    expect(linkIn(without)?.href).toBe("https://linkedin-urn-collector.vercel.app/");
    // It is next to the input it feeds, not adrift on the page.
    expect(without.querySelector('[name="linkedin_urn"]')?.closest(".profile__form-row")).toBe(
      linkIn(without)?.closest(".profile__form-row"),
    );

    const filled = renderPage(
      createState(createMember({ linkedin_urn: "ACoAAB1234567" } as Partial<LabMember>)),
      vi.fn(),
    );
    expect(linkIn(filled)).not.toBeNull();
    // And the old suggestion card is gone, not duplicated.
    expect(without.querySelector('[data-testid="suggestion-linkedin-urn"]')).toBeNull();
  });

  // Both fields ask for something a member has no reason to have heard of, so each carries an
  // explanation next to its own name rather than at the bottom of the page.
  it("explains the URN and the application form on hover, beside their labels", () => {
    const container = renderPage(createState(createMember()), vi.fn());
    for (const key of ["linkedin_urn", "intake_form_url"]) {
      const trigger = container.querySelector<HTMLButtonElement>(
        `[data-testid="profile-help-${key}"]`,
      );
      expect(trigger).not.toBeNull();
      // The bubble is wired to the trigger for anyone not using a pointer.
      const describedBy = trigger!.getAttribute("aria-describedby")!;
      const bubble = container.querySelector(`#${describedBy}`);
      expect(bubble?.getAttribute("role")).toBe("tooltip");
      expect((bubble?.textContent ?? "").length).toBeGreaterThan(40);
      // It sits with the field's own label.
      expect(trigger!.closest(".profile__form-label")).not.toBeNull();
    }
  });

  // The service refuses a GitHub link that points at a repository, a LinkedIn link without /in/,
  // and an OpenReview id that is not a tilde handle. A member used to meet those rules only as a
  // rejected save.
  it("states the accepted shape under the fields that have one", () => {
    const container = renderPage(createState(createMember()), vi.fn());

    const hint = (key: string) =>
      container.querySelector(`[data-testid="profile-hint-${key}"]`)?.textContent?.trim();
    expect(hint("github_url")).toContain("github.com/username");
    expect(hint("linkedin_url")).toContain("linkedin.com/in/username");
    expect(hint("openreview_id")).toContain("~Zhijing_Jin1");
    // The obvious ones stay quiet -- a hint on every row is a page nobody reads.
    expect(container.querySelector('[data-testid="profile-hint-name"]')).toBeNull();
  });

  // The member cannot type a URN in; all they need is whether the lab has one yet, and the
  // collector link while it does not.
  // Editable now: it was disabled, which cannot be focused, selected or pasted into, so the member
  // could neither follow the field's own "look it up and paste it here" instruction nor copy the
  // stored one out. The status line beside it stays, because "on file or not" is still the thing
  // the member is checking when they look.
  it("shows the URN as an editable value with its on-file state beside it", () => {
    const filled = renderPage(
      createState(createMember({ linkedin_urn: "ACoAAB1234567" } as Partial<LabMember>)),
      vi.fn(),
    );
    const input = filled.querySelector<HTMLInputElement>('input[name="linkedin_urn"]');
    expect(input?.disabled).toBe(false);
    expect(input?.value).toBe("ACoAAB1234567");
    expect(filled.querySelector('[data-testid="profile-urn-status"]')?.textContent?.trim()).toBe(
      "On file",
    );

    const blank = renderPage(createState(createMember()), vi.fn());
    expect(blank.querySelector('[data-testid="profile-urn-status"]')?.textContent?.trim()).toBe(
      "Not on file yet — use the collector",
    );
    // No required dot: the form does not let them answer it, so it must not chase them for one.
    const row = blank.querySelector('[name="linkedin_urn"]')?.closest(".profile__form-row");
    expect(row?.querySelector(".profile__mandatory")).toBeNull();
  });

  // Three states, not two. "Unknown" renders nothing, because labelling someone Inactive from a
  // measurement that was never taken is an accusation drawn from a gap.
  it("shows the Slack activity state beside the name once it has been measured", () => {
    const active = renderPage(
      createState(
        createMember({
          slack_user_id: "U1",
          slack_messages_7d: 6,
          slack_activity_checked_at: "2026-08-11T00:00:00.000Z",
        } as Partial<LabMember>),
      ),
      vi.fn(),
    );
    const pill = active.querySelector('[data-testid="profile-slack-activity"]');
    expect(pill?.getAttribute("data-activity")).toBe("active");
    expect(pill?.textContent?.trim()).toContain("Active");
    // It sits with the name, not down in the field list.
    expect(pill?.closest(".profile__hero")).not.toBeNull();

    const inactive = renderPage(
      createState(
        createMember({
          slack_user_id: "U1",
          slack_messages_7d: 1,
          slack_activity_checked_at: "2026-08-11T00:00:00.000Z",
        } as Partial<LabMember>),
      ),
      vi.fn(),
    );
    expect(
      inactive.querySelector('[data-testid="profile-slack-activity"]')?.getAttribute("data-activity"),
    ).toBe("inactive");
  });

  it("shows nothing at all when activity has never been measured", () => {
    // The fixture member carries a slack_user_id but no measurement.
    const container = renderPage(createState(createMember()), vi.fn());
    expect(container.querySelector('[data-testid="profile-slack-activity"]')).toBeNull();
  });

  it("offers the personal-circumstances note as an optional paragraph with an explanation", () => {
    const container = renderPage(createState(createMember()), vi.fn());
    const field = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="personal_circumstances"]',
    );
    // A paragraph, not a one-line input: it is the only field on the page worth several sentences.
    expect(field).not.toBeNull();
    const row = field?.closest(".profile__form-row");
    expect(row?.querySelector(".profile__optional")).not.toBeNull();
    expect(row?.querySelector(".profile__mandatory")).toBeNull();
    // And says who can read it, since that is the thing a person needs to know before answering.
    const help = container.querySelector('[data-testid="profile-help-personal_circumstances"]');
    expect(help).not.toBeNull();
    const bubble = container.querySelector(`#${help!.getAttribute("aria-describedby")}`);
    expect(bubble?.textContent).toContain("admins");
  });

  it("offers a preferred name, optional, beside the roster name", () => {
    const container = renderPage(createState(createMember()), vi.fn());
    const input = container.querySelector<HTMLInputElement>('input[name="preferred_name"]');
    expect(input).not.toBeNull();
    expect(input?.closest(".profile__form-row")?.querySelector(".profile__optional")).not.toBeNull();
  });

  // Slack ids are written by the directory sync, never typed. Leaving the input on the page invited
  // someone to paste a wrong one over a correct synced value.
  it("no longer offers a Slack ID field", () => {
    const container = renderPage(createState(createMember()), vi.fn());
    expect(container.querySelector('[name="slack_user_id"]')).toBeNull();
  });

  it("groups location and time zone with identity rather than work logistics", () => {
    const container = renderPage(createState(createMember()), vi.fn());
    const groupOf = (name: string) =>
      container
        .querySelector(`[name="${name}"]`)
        ?.closest(".profile__field-group")
        ?.querySelector(".profile__group-title")?.textContent?.trim();
    const identity = groupOf("name");
    expect(groupOf("location")).toBe(identity);
    expect(groupOf("timezone")).toBe(identity);
  });

  // Advisory only: most imported numbers have no country code, and this form PUTs every field on
  // each autosave, so rejecting the value would block unrelated profile edits.
  it("flags a WhatsApp number with no country code without blocking the save", () => {
    const withCode = renderPage(
      createState(createMember({ whatsapp: "+1 555 0100" } as Partial<LabMember>)),
      vi.fn(),
    );
    expect(withCode.querySelector('[data-testid="profile-whatsapp-hint"]')).toBeNull();

    const onSave = vi.fn();
    const without = renderPage(
      createState(createMember({ whatsapp: "4038907525" } as Partial<LabMember>)),
      onSave,
    );
    expect(without.querySelector('[data-testid="profile-whatsapp-hint"]')).not.toBeNull();
    // Still saves: the hint is a nudge, not a gate. An edit has to be pending for the
    // leave-the-form flush to have anything to commit.
    const form = without.querySelector<HTMLFormElement>(".profile__form");
    form?.querySelector<HTMLInputElement>('[name="preferred_name"]')
      ?.dispatchEvent(new Event("input", { bubbles: true }));
    form?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(onSave).toHaveBeenCalled();
  });

  // The page's required marks and the service's daily reminder read one list, so neither can chase
  // a field the other calls skippable. They used to be two hand-kept lists that never agreed.
  //
  // The one documented exception is linkedin_urn: still mandatory for the record, but filled by an
  // admin, so the member's own page does not dot it. The service reminder still names it.
  it("marks exactly the shared mandatory list required, minus the admin-filled ones", () => {
    // Every mandatory field blank, so the marks stand for the whole list rather than the subset
    // this fixture happens to leave unanswered.
    const blanks = Object.fromEntries(
      adminBotMandatoryProfileFields.map((key) => {
        const current = createMember()[key as keyof LabMember];
        return [key, Array.isArray(current) ? [] : typeof current === "number" ? undefined : ""];
      }),
    ) as Partial<LabMember>;
    const container = renderPage(createState(createMember(blanks)), vi.fn());
    const marked = [...container.querySelectorAll<HTMLElement>(".profile__form-row")]
      .filter((row) => row.querySelector(".profile__mandatory"))
      // `:not` skips the phone field's country picker, which is a control of the form rather than
      // a column of the record.
      .map((row) => row.querySelector<HTMLElement>('[name]:not([name$="__dial"])'))
      .map((control) => control?.getAttribute("name"))
      .filter((name): name is string => Boolean(name));
    expect(marked.toSorted()).toEqual(
      [...adminBotMandatoryProfileFields].filter((key) => key !== "linkedin_urn").toSorted(),
    );
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

      // Merely passing through the form saves nothing -- the guess rides the member's own next
      // edit, so an untouched page never writes a value they did not choose.
      form?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(onSave).not.toHaveBeenCalled();

      const nameInput = container.querySelector<HTMLInputElement>('input[name="name"]')!;
      nameInput.value = "Pat Edited";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      form?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

      expect(onSave).toHaveBeenCalled();
      expect(onSave.mock.calls.at(-1)?.[1].timezone).toBe("America/Toronto");
    });
  });

  // It is the member's own answers, not the lab's blank form. Google Forms only ever hands the
  // edit link to the respondent, so nobody else can produce it for them -- which is why this is a
  // field they paste into rather than a link the profile could render.
  it("collects the member's own application form URL as a required field, not a shared link", () => {
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
    // Required, and in the links group beside the other places a member's details live.
    const row = input?.closest(".profile__form-row");
    expect(row?.querySelector(".profile__optional")).toBeNull();
    expect(row?.querySelector(".profile__mandatory")).not.toBeNull();
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

  it("renders github_url as a url input, and asks for weekly work capacity as a bounded number", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(container.querySelector<HTMLInputElement>('input[name="github_url"]')?.type).toBe("url");
    // Weekly capacity is the denominator the Time Availability chart reads every commitment
    // against, so the page has to ask for it. Bounded to the range the service accepts, so an
    // impossible week is refused by the control rather than by a rejected save.
    const hours = container.querySelector<HTMLInputElement>(
      'input[name="hours_per_week"]',
    );
    expect(hours?.type).toBe("number");
    expect(hours?.min).toBe("0");
    expect(hours?.max).toBe("168");
    expect(hours?.placeholder).toContain("40");
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

describe("renderProfile completion ledger", () => {
  // The ledger drew one tick per non-optional field but counted only the member-answerable ones,
  // so it claimed "N of 12" under 13 marks -- and the extra, the admin-owned URN, was never in
  // blankFields and so always drew as filled whether or not the lab had supplied it.
  it("draws exactly one tick per field it counts, and none for admin-filled ones", () => {
    const container = renderPage(createState(createMember()), vi.fn());

    const ledger = container.querySelector('[data-testid="profile-ledger"]')!;
    const ticks = ledger.querySelectorAll(".profile__tick");
    const total = Number(
      /of (\d+)/u.exec(
        container.querySelector(".profile__completeness")?.getAttribute("aria-label") ?? "",
      )?.[1],
    );

    expect(total).toBeGreaterThan(0);
    expect(ticks.length).toBe(total);
    expect([...ticks].map((tick) => tick.getAttribute("title"))).not.toContain("LinkedIn URN");
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
    // No "Account" group any more: it held one row, the directory email, which the hero already
    // prints under the member's name. The closing line says who owns that address instead.
    expect(
      groups.some((group) =>
        group.querySelector(".profile__group-title")?.textContent?.includes("Account"),
      ),
    ).toBe(false);
    expect(basics.textContent).not.toContain("pat@example.com");
  });

  // The one field on the page a member may want to think before answering, and the one the lab
  // hides from every other reader. It comes last so nobody meets it on the way to a phone number.
  it("puts medical conditions in the last group on the page", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    const groups = [...basics.querySelectorAll(".profile__field-group")];
    const last = groups.at(-1);
    expect(last?.querySelector('textarea[name="personal_circumstances"]')).not.toBeNull();
  });

  it("asks for other social media as a paragraph instead of a LessWrong link", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(container.querySelector('textarea[name="other_socials"]')).not.toBeNull();
    expect(container.querySelector('input[name="lesswrong_url"]')).toBeNull();
  });

  // One control per value: the header card's avatar is click-to-edit and saves through the same
  // handler, so a second uploader inside the basics card was the same field asked for twice.
  it("keeps the picture in the header and not in the basics card", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    expect(container.querySelector(".profile__hero .profile__avatar-slot")).not.toBeNull();
    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    expect(basics.querySelector(".profile__upload")).toBeNull();
    expect(basics.querySelector('[data-testid="profile-avatar-upload-field"]')).toBeNull();
  });

  // Role is stated once, in the pill beside the name. It used to be pushed into the badge list as
  // well, so every member carried a "badge" that was just a copy of a dropdown they had answered.
  it("does not repeat the role as a badge", () => {
    const container = renderPage(
      createState(createMember({ role: "Postdoc" } as Partial<LabMember>)),
      vi.fn(),
    );

    expect(container.querySelector(".profile__role-pill")?.textContent?.trim()).toBe("Postdoc");
    const badges = [...container.querySelectorAll(".profile-badge")].map((badge) =>
      badge.textContent?.trim(),
    );
    expect(badges).not.toContain("Postdoc");
  });

  // Badges moved out of the header into a section of their own, next to the nomination form. The
  // header keeps the completeness ring, which is the one thing it still states about the record.
  it("shows a completeness indicator in the header and badges in their own section", () => {
    // A badge is something the record earns, so the fixture has to earn one: authorship of a paper
    // it submitted. (Role is not a badge -- see the test above.)
    const member = createMember();
    const state = createState(member, {
      adminBotData: {
        members: [member],
        papers: [{ id: "p1", title: "A paper", submitted_by_member_id: member.id }],
      },
    } as unknown as Partial<AppViewState>);
    const container = renderPage(state, vi.fn());

    const hero = container.querySelector(".profile__hero")!;
    expect(hero).not.toBeNull();
    expect(hero.querySelector('[data-testid="profile-badges"]')).toBeNull();
    expect(hero.querySelector(".profile__completeness-percent")?.textContent).toMatch(/^\d+%$/);

    const section = container.querySelector('[data-testid="profile-badges-section"]');
    expect(section).not.toBeNull();
    expect(section?.querySelector('[data-testid="profile-badges"]')).not.toBeNull();
    // Immediately above the nomination form: "what I have" and "what I could ask for" are one
    // subject, and they used to sit at opposite ends of the page.
    expect(section?.nextElementSibling?.getAttribute("data-testid")).toBe(
      "profile-badge-nominations",
    );
  });

  it("shows admin-managed badges ahead of computed badges and renders the self-nomination form", () => {
    const member = createMember({
      assigned_badges: [
        {
          member_id: "pat",
          badge_id: "causality__level_2",
          family_key: "causality",
          awarded_at: "2026-08-01T00:00:00.000Z",
          awarded_by: "admin",
          source: "admin",
          category: "Causality",
          name: "Causality",
          tier: "Level 2",
          description: "Causal researcher with at least one main-conference publication.",
          sort_order: 70,
        },
      ],
    } as Partial<LabMember>);
    const state = createState(member, {
      adminBotData: {
        members: [member],
        papers: [{ id: "p1", title: "A paper", submitted_by_member_id: member.id }],
      },
      adminBotBadgeDefinitions: [
        {
          id: "team_contributor__infra_builder",
          family_key: "team_contributor__infra_builder",
          category: "Team Contributor",
          name: "Infra Builder",
          description: "Built or maintains shared lab infrastructure.",
          sort_order: 10,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        },
      ],
      profileBadgeNominations: [],
    } as unknown as Partial<AppViewState>);
    const container = renderPage(state, vi.fn());

    const badges = [...container.querySelectorAll(".profile-badge")].map((badge) =>
      badge.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(badges[0]).toContain("Causality · Level 2");
    expect(badges.some((badge) => badge?.includes("Author"))).toBe(true);
    expect(container.querySelector('[data-testid="profile-badge-nominations"]')).not.toBeNull();
    expect(container.querySelector('input[name="badge_id"]')).not.toBeNull();
    expect(container.querySelector('textarea[name="evidence"][required]')).not.toBeNull();
    expect(container.textContent).toContain("Built or maintains shared lab infrastructure.");
  });

  it("edits the record in place, with no edit button and no separate blanks card", () => {
    const member = createMember({ role: "", location: "" });
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    // The record is editable on arrival: no click stands between the member and a correction.
    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    expect(basics.querySelector('input[name="name"]')).not.toBeNull();
    expect(basics.querySelector('select[name="role"]')).not.toBeNull();

    // The edit affordance and the duplicate fill-in-the-blanks form are both gone. The Save
    // button that remains is not one of them: it does not gate editing, it ends it.
    expect(container.querySelector('[data-testid="profile-basics-edit"]')).toBeNull();
    expect(container.querySelector('[data-testid="profile-blanks"]')).toBeNull();
  });

  // Autosave still does the writing. The button exists so a member who has just made a correction
  // can finish it, rather than waiting out a debounce they cannot see -- so it must commit even
  // when no timer is pending, which is the case a flush-only handler silently no-ops on.
  it("saves on demand as well as automatically", () => {
    const member = createMember();
    const state = createState(member);
    const onSave = vi.fn();
    const container = renderPage(state, onSave);

    const save = container.querySelector<HTMLButtonElement>('[data-testid="profile-basics-save"]')!;
    save.click();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBe(member.id);
  });

  it("keeps the governed email out of the always-editable record", () => {
    const member = createMember();
    const state = createState(member);
    const container = renderPage(state, vi.fn());

    const basics = container.querySelector('[data-testid="profile-basics"]')!;
    // Email is the lab's to set, and the form simply does not mention it: no input, no locked row
    // repeating what the hero already shows, and no standing sentence about a field that is not
    // on the page.
    expect(basics.querySelector('input[name="email"]')).toBeNull();
    expect(basics.querySelector(".profile-field--locked")).toBeNull();
    expect(basics.querySelector(".profile__managed")).toBeNull();
  });
});

describe("the LinkedIn URN", () => {
  // It was a disabled input, which cannot be focused, selected or pasted into -- so a member who
  // had looked theirs up in the collector tool the help text points at had nowhere to put it, and
  // could not copy the stored one out either.
  it("is typable and pasteable rather than disabled", () => {
    const container = renderPage(
      createState(createMember({ linkedin_urn: "ACoAAB1234567" })),
      () => {},
    );
    const input = container.querySelector<HTMLInputElement>(
      "[data-testid='profile-admin-only-linkedin_urn']",
    );
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(false);
    expect(input?.readOnly).toBe(false);
    expect(input?.value).toBe("ACoAAB1234567");
  });

  // Editable is a separate question from chased. One member of 199 has a URN, so counting it would
  // drop fifty profiles off 100% and nudge every one of them for a field nobody has heard of.
  it("stays out of the completion ledger and carries no mandatory dot", () => {
    const container = renderPage(createState(createMember()), () => {});
    const field = container
      .querySelector("[data-testid='profile-admin-only-linkedin_urn']")
      ?.closest("label");
    expect(field?.querySelector(".profile__mandatory")).toBeNull();
  });
});
