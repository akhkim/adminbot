/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TravelOverview } from "../data/lab-travel.ts";
import { renderTravelNearby, type TravelNearbyProps } from "./lab-travel.nearby.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function overview(overrides: Partial<TravelOverview> = {}): TravelOverview {
  return {
    today: "2026-10-13",
    conferences: [],
    sharing: { enabled: false },
    plans: [{ start: "2026-11-01", end: "2026-11-05", city: "Berlin" }],
    home: "Toronto",
    matches: [],
    sharing_members: 2,
    ...overrides,
  };
}

function props(overrides: Partial<TravelNearbyProps> = {}): TravelNearbyProps {
  return {
    overview: overview(),
    loading: false,
    error: null,
    notice: null,
    busy: null,
    onRetry: vi.fn(),
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

function draw(overrides: Partial<TravelNearbyProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const resolved = props(overrides);
  render(renderTravelNearby(resolved), container);
  const q = <T extends Element = HTMLElement>(testid: string) =>
    container.querySelector<T>(`[data-testid="${testid}"]`);
  return { container, props: resolved, q };
}

describe("finding lab members nearby", () => {
  it("says what sharing shares before anything is shared, and opts in on a press", () => {
    const { q, props: wired } = draw();
    const hint = q("lab-travel-sharing-off")?.textContent ?? "";
    expect(hint).toContain("never more precise than about a kilometre");
    expect(hint).toContain("deleted");
    q<HTMLButtonElement>("lab-travel-enable-sharing")?.click();
    expect(wired.onEnableSharing).toHaveBeenCalledOnce();
    // Nothing about anybody else is drawn while the viewer is not sharing, the lookup included:
    // the service only answers it for a member who shares too.
    expect(q("lab-travel-lookup")).toBeNull();
  });

  it("shows the last place, this browser's state, the matches and the way out", () => {
    const sharing = {
      enabled: true,
      location: { label: "Paris", country: "France", reported_at: new Date().toISOString() },
    };
    const { q, props: wired } = draw({
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
    const empty = q("lab-travel-group-people-trip:0")?.textContent ?? "";
    expect(empty).toContain("No one who shares their location yet");
    expect(empty).toContain("(2 besides you)");
    q<HTMLButtonElement>("lab-travel-update-now")?.click();
    expect(wired.onShareFromDevice).toHaveBeenCalledOnce();
    q<HTMLButtonElement>("lab-travel-disable-sharing")?.click();
    expect(wired.onDisableSharing).toHaveBeenCalledOnce();
    expect(q("lab-travel-lookup")).not.toBeNull();
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
        sharing_members: 0,
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
    expect(result).toContain("No one who shares their location will be in Atlantis then");
    expect(result).toContain("No other member shares their location yet");
  });
});

describe("loading, errors and notices", () => {
  it("shows a retry on error and a loading line before the first read", () => {
    const failed = draw({ overview: null, error: "The service answered 500." });
    expect(failed.container.textContent).toContain("The service answered 500.");
    failed.container.querySelector<HTMLButtonElement>(".callout button")?.click();
    expect(failed.props.onRetry).toHaveBeenCalledOnce();
    document.body.innerHTML = "";
    expect(draw({ overview: null, loading: true }).container.textContent).toContain(
      "Loading who is nearby",
    );
  });

  it("says what the last sharing action did inside the card", () => {
    const { container } = draw({ notice: { kind: "success", text: "Location sharing is on." } });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Location sharing is on.",
    );
  });
});
