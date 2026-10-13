/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TravelConference, TravelOverview } from "../data/lab-travel.ts";
import { EMPTY_TRIP_DRAFT } from "./lab-travel.plans.ts";
import { renderLabTravel, type LabTravelProps } from "./lab-travel.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const EMNLP: TravelConference = {
  key: "emnlp:2026",
  group_key: "emnlp:2026",
  label: "EMNLP 2026",
  conference_label: "EMNLP 2026",
  family: "EMNLP",
  year: 2026,
  location: "Budapest, Hungary",
  city: "Budapest",
  country: "Hungary",
  multi_site: false,
  starts: "2026-10-24",
  ends: "2026-10-29",
  homepage_url: "https://2026.emnlp.org/",
  going: [
    { member_id: "bob", name: "Bob Member", airbnb: true },
    { member_id: "cy", name: "Cy Member", airbnb: false },
  ],
  undecided_count: 1,
  airbnb_count: 1,
};

const PARIS: TravelConference = {
  key: "neuripsparis:2026",
  group_key: "neurips:2026",
  label: "NeurIPS 2026 — Paris",
  conference_label: "NeurIPS 2026",
  family: "NeurIPS",
  year: 2026,
  location: "Paris, France",
  city: "Paris",
  multi_site: true,
  starts: "2026-12-09",
  ends: "2026-12-11",
  going: [],
  undecided_count: 0,
  airbnb_count: 0,
};

function overview(overrides: Partial<TravelOverview> = {}): TravelOverview {
  return {
    today: "2026-10-13",
    conferences: [EMNLP, PARIS],
    sharing: { enabled: false },
    plans: [{ start: "2026-11-01", end: "2026-11-05", city: "Berlin" }],
    home: "Toronto",
    matches: [],
    ...overrides,
  };
}

function props(overrides: Partial<LabTravelProps> = {}): LabTravelProps {
  return {
    overview: overview(),
    loading: false,
    error: null,
    notice: null,
    busy: null,
    onRetry: vi.fn(),
    rsvpOpen: null,
    rsvpDrafts: {},
    onOpenRsvp: vi.fn(),
    onEditRsvp: vi.fn(),
    onSaveRsvp: vi.fn(),
    onWithdrawRsvp: vi.fn(),
    planDraft: EMPTY_TRIP_DRAFT,
    onPlanDraftChange: vi.fn(),
    onSavePlans: vi.fn(),
    sharing: null,
    device: { status: "idle" },
    onEnableSharing: vi.fn(),
    onDisableSharing: vi.fn(),
    onShareFromDevice: vi.fn(),
    cityDraft: "",
    onCityDraftChange: vi.fn(),
    onShareCity: vi.fn(),
    lookupDraft: { place: "", from: "", to: "" },
    onLookupDraftChange: vi.fn(),
    onLookup: vi.fn(),
    lookup: null,
    lookupError: null,
    ...overrides,
  };
}

function draw(overrides: Partial<LabTravelProps> = {}, viewerId: string | null = "ada") {
  const container = document.createElement("div");
  document.body.append(container);
  const resolved = props(overrides);
  render(renderLabTravel(resolved, viewerId), container);
  const q = <T extends Element = HTMLElement>(testid: string) =>
    container.querySelector<T>(`[data-testid="${testid}"]`);
  return { container, props: resolved, q };
}

describe("the conference list", () => {
  it("shows one entry per site with its dates, place and who is going", () => {
    const { q } = draw();
    const emnlp = q("lab-travel-conference-emnlp:2026")!;
    expect(emnlp.textContent).toContain("EMNLP 2026");
    expect(emnlp.textContent).toContain("Budapest, Hungary");
    const going = q("lab-travel-going-emnlp:2026")!.textContent ?? "";
    expect(going).toContain("Bob Member");
    expect(going).toContain("Airbnb");
    expect(going).toContain("1 still deciding");
    expect(going).toContain("1 in the lab Airbnb");
    expect(q("lab-travel-going-neuripsparis:2026")?.textContent).toContain("Nobody from the lab");
    expect(q("lab-travel-conference-neuripsparis:2026")?.textContent).toContain(
      "NeurIPS 2026 — Paris",
    );
  });

  it("marks the viewer in the going list and shows their status", () => {
    const mine = {
      ...EMNLP,
      going: [...EMNLP.going, { member_id: "ada", name: "Ada Member", airbnb: true }],
      my_rsvp: {
        conference_key: "emnlp:2026",
        member_id: "ada",
        intent: "going" as const,
        funding: "none" as const,
        needs_lodging: true,
        needs_visa_letter: false,
        updated_at: "2026-10-01T00:00:00Z",
      },
    };
    const { q } = draw({ overview: overview({ conferences: [mine] }) });
    expect(q("lab-travel-going-emnlp:2026")?.textContent).toContain("(you)");
    expect(q("lab-travel-status-emnlp:2026")?.textContent).toContain("You're going · Airbnb");
    expect(q("lab-travel-open-rsvp-emnlp:2026")?.textContent).toContain("Change RSVP");
  });

  it("asks a member who answered before the sites existed to pick one", () => {
    const unsited = {
      ...PARIS,
      unsited_rsvp: {
        conference_key: "neurips:2026",
        member_id: "ada",
        intent: "going" as const,
        funding: "none" as const,
        needs_lodging: false,
        needs_visa_letter: false,
        updated_at: "2026-09-01T00:00:00Z",
      },
    };
    const { container } = draw({ overview: overview({ conferences: [unsited] }) });
    expect(container.textContent).toContain("before its locations were listed");
  });

  it("opens the RSVP form from its button", () => {
    const { q, props: wired } = draw();
    q<HTMLButtonElement>("lab-travel-open-rsvp-emnlp:2026")?.click();
    expect(wired.onOpenRsvp).toHaveBeenCalledWith("emnlp:2026");
  });
});

describe("the RSVP form", () => {
  it("opens with no answer chosen and will not save until one is", () => {
    const { q } = draw({ rsvpOpen: "emnlp:2026" });
    expect(q("lab-travel-intent-going-emnlp:2026")?.getAttribute("aria-pressed")).toBe("false");
    expect(q<HTMLButtonElement>("lab-travel-save-emnlp:2026")?.disabled).toBe(true);
    // Nothing beyond the question until they say they are going.
    expect(q("lab-travel-airbnb-emnlp:2026")).toBeNull();
  });

  it("reports the choice", () => {
    const { q, props: wired } = draw({ rsvpOpen: "emnlp:2026" });
    q<HTMLButtonElement>("lab-travel-intent-going-emnlp:2026")?.click();
    expect(wired.onEditRsvp).toHaveBeenCalledWith(EMNLP, { intent: "going" });
  });

  it("asks the Airbnb, money and visa questions once going, and nights once in the Airbnb", () => {
    const going = {
      intent: "going" as const,
      airbnb: false,
      arrival_on: "",
      departure_on: "",
      funding: "none" as const,
      needs_visa_letter: false,
      notes: "",
    };
    const first = draw({ rsvpOpen: "emnlp:2026", rsvpDrafts: { "emnlp:2026": going } });
    expect(first.q("lab-travel-airbnb-emnlp:2026")).not.toBeNull();
    expect(first.q("lab-travel-funding-emnlp:2026")?.textContent).toContain("Full travel");
    expect(first.q("lab-travel-visa-emnlp:2026")).not.toBeNull();
    expect(first.q("lab-travel-arrival-emnlp:2026")).toBeNull();
    expect(first.container.textContent).toContain("Only you and the admins see");
    expect(first.q<HTMLButtonElement>("lab-travel-save-emnlp:2026")?.disabled).toBe(false);
    document.body.innerHTML = "";
    const second = draw({
      rsvpOpen: "emnlp:2026",
      rsvpDrafts: {
        "emnlp:2026": {
          ...going,
          airbnb: true,
          arrival_on: "2026-10-24",
          departure_on: "2026-10-29",
        },
      },
    });
    expect(second.q<HTMLInputElement>("lab-travel-arrival-emnlp:2026")?.value).toBe("2026-10-24");
    expect(second.q("lab-travel-departure-emnlp:2026")).not.toBeNull();
  });

  it("refuses nights in the wrong order", () => {
    const { q, container } = draw({
      rsvpOpen: "emnlp:2026",
      rsvpDrafts: {
        "emnlp:2026": {
          intent: "going",
          airbnb: true,
          arrival_on: "2026-10-29",
          departure_on: "2026-10-24",
          funding: "none",
          needs_visa_letter: false,
          notes: "",
        },
      },
    });
    expect(q<HTMLButtonElement>("lab-travel-save-emnlp:2026")?.disabled).toBe(true);
    expect(container.textContent).toContain("before the arriving date");
  });

  it("offers 'not going' only to somebody who has answered", () => {
    expect(draw({ rsvpOpen: "emnlp:2026" }).q("lab-travel-withdraw-emnlp:2026")).toBeNull();
    document.body.innerHTML = "";
    const answered = {
      ...EMNLP,
      my_rsvp: {
        conference_key: "emnlp:2026",
        member_id: "ada",
        intent: "undecided" as const,
        funding: "none" as const,
        needs_lodging: false,
        needs_visa_letter: false,
        updated_at: "2026-10-01T00:00:00Z",
      },
    };
    const { q, props: wired } = draw({
      rsvpOpen: "emnlp:2026",
      overview: overview({ conferences: [answered] }),
    });
    q<HTMLButtonElement>("lab-travel-withdraw-emnlp:2026")?.click();
    expect(wired.onWithdrawRsvp).toHaveBeenCalledWith(answered);
  });
});

describe("the other travel plans", () => {
  it("lists the member's trips with the editor", () => {
    const { q } = draw();
    expect(q("lab-travel-plans")?.textContent).toContain("Berlin");
    expect(q("lab-travel-plan-form")).not.toBeNull();
  });
});

describe("finding lab members nearby", () => {
  it("says what sharing shares before anything is shared, and opts in on a press", () => {
    const { q, props: wired } = draw();
    const hint = q("lab-travel-sharing-off")?.textContent ?? "";
    expect(hint).toContain("never more precise than about a kilometre");
    expect(hint).toContain("deleted");
    q<HTMLButtonElement>("lab-travel-enable-sharing")?.click();
    expect(wired.onEnableSharing).toHaveBeenCalledOnce();
    // Nothing about anybody else is drawn while the viewer is not sharing.
    expect(q("lab-travel-lookup")).toBeNull();
  });

  it("shows the last place, this browser's state, the matches and the way out", () => {
    const sharing = {
      enabled: true,
      location: { label: "Paris", country: "France", reported_at: new Date().toISOString() },
    };
    const {
      q,
      props: wired,
      container,
    } = draw({
      sharing,
      device: { status: "watching", lastSentAt: new Date().toISOString() },
      overview: overview({
        sharing,
        matches: [
          {
            id: "now",
            kind: "now",
            title: "Near you now — Paris",
            place: { label: "Paris", key: "paris" },
            people: [
              {
                member_id: "cy",
                name: "Cy Member",
                basis: "live",
                place: { label: "Paris" },
                distance_km: 5,
              },
              { member_id: "bob", name: "Bob Member", basis: "home", place: { label: "Paris" } },
            ],
          },
          {
            id: "trip:0",
            kind: "trip",
            title: "Your trip to Berlin",
            place: { label: "Berlin" },
            from: "2026-11-01",
            to: "2026-11-05",
            people: [],
          },
        ],
      }),
    });
    expect(q("lab-travel-sharing-on")?.textContent).toContain("Paris, France");
    expect(q("lab-travel-device")?.textContent).toContain("Updating automatically");
    const now = q("lab-travel-group-people-now")?.textContent ?? "";
    expect(now).toContain("Cy Member");
    expect(now).toContain("about 5 km away");
    expect(now).toContain("Lives here");
    expect(q("lab-travel-group-people-trip:0")?.textContent).toContain("No one from the lab yet");
    q<HTMLButtonElement>("lab-travel-update-now")?.click();
    expect(wired.onShareFromDevice).toHaveBeenCalledOnce();
    q<HTMLButtonElement>("lab-travel-disable-sharing")?.click();
    expect(wired.onDisableSharing).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="lab-travel-lookup"]')).not.toBeNull();
  });

  it("explains each way this browser can fail to share, and offers a typed city", () => {
    const sharing = { enabled: true };
    for (const [status, text] of [
      ["denied", "blocked for this site"],
      ["insecure", "HTTPS"],
      ["unsupported", "cannot share its location"],
      ["needs-permission", "has not been allowed"],
    ] as const) {
      document.body.innerHTML = "";
      const { q } = draw({ sharing, device: { status }, overview: overview({ sharing }) });
      expect(q("lab-travel-device")?.textContent).toContain(text);
      expect(q("lab-travel-city")).not.toBeNull();
    }
  });

  it("submits a typed city and a lookup", () => {
    const sharing = { enabled: true };
    const { q, props: wired } = draw({
      sharing,
      cityDraft: "Lisbon",
      overview: overview({ sharing }),
      lookup: {
        place: { label: "Atlantis" },
        resolved: false,
        from: "2026-10-13",
        to: "2026-10-13",
        people: [],
      },
    });
    q<HTMLFormElement>("lab-travel-city")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(wired.onShareCity).toHaveBeenCalledOnce();
    q<HTMLFormElement>("lab-travel-lookup")?.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    expect(wired.onLookup).toHaveBeenCalledOnce();
    const result = q("lab-travel-lookup-result")?.textContent ?? "";
    expect(result).toContain("does not know where Atlantis is");
    expect(result).toContain("No one from the lab will be in Atlantis then");
  });
});

describe("loading and errors", () => {
  it("shows a retry on error and a loading line before the first read", () => {
    const failed = draw({ overview: null, error: "The service answered 500." });
    expect(failed.container.textContent).toContain("The service answered 500.");
    failed.container.querySelector<HTMLButtonElement>(".callout button")?.click();
    expect(failed.props.onRetry).toHaveBeenCalledOnce();
    document.body.innerHTML = "";
    expect(draw({ overview: null, loading: true }).container.textContent).toContain(
      "Loading travel",
    );
  });
});
