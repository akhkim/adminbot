// The admin map coverage panel. Synthetic members only.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotMapCoverage } from "./map-coverage.ts";
import { lastSeenText, parseMapCoverage } from "./map-coverage.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const body = {
  active: 4,
  counts: {
    device: 2,
    ip: 1,
    checkin: 1,
    stored_city: 1,
    timezone: 0,
    country: 0,
    unplaced: 1,
    hidden: 0,
    suspected_vpn: 1,
  },
  stale: [
    { member_id: "m1", name: "Person One", placed_by: "unplaced" },
    {
      member_id: "m2",
      name: "Person Two",
      placed_by: "stored_city",
      place_label: "Zürich",
      suspected_vpn: true,
      last_seen_at: "2026-07-01T10:00:00.000Z",
    },
  ],
};

describe("parseMapCoverage", () => {
  it("keeps well-formed rows and refuses a body that is not coverage", () => {
    expect(parseMapCoverage(body)?.stale).toHaveLength(2);
    expect(parseMapCoverage({ error: { message: "forbidden" } })).toBeNull();
    expect(
      parseMapCoverage({ ...body, stale: [{ member_id: "x", name: "X", placed_by: "ip" }] })?.stale,
    ).toEqual([]);
  });
});

describe("lastSeenText", () => {
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  it("speaks in UTC days", () => {
    expect(lastSeenText("2026-07-15T00:30:00.000Z", now)).toBe("today");
    expect(lastSeenText("2026-07-14T23:30:00.000Z", now)).toBe("yesterday");
    expect(lastSeenText("2026-07-01T10:00:00.000Z", now)).toBe("14d ago");
    expect(lastSeenText(undefined, now)).toBe("never");
  });
});

async function openPanel(el: AdminBotMapCoverage) {
  await el.updateComplete;
  const panel = el.querySelector<HTMLDetailsElement>('[data-testid="map-coverage"]');
  panel!.open = true;
  panel!.dispatchEvent(new Event("toggle"));
}

describe("<adminbot-map-coverage>", () => {
  it("stays collapsed and fetches nothing until an admin opens it", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => body }));
    vi.stubGlobal("fetch", fetcher);
    await import("./map-coverage.ts");
    const el = document.createElement("adminbot-map-coverage") as AdminBotMapCoverage;
    el.sessionToken = "synthetic-session";
    document.body.append(el);
    await el.updateComplete;
    expect(el.querySelector<HTMLDetailsElement>('[data-testid="map-coverage"]')?.open).toBe(false);
    expect(el.querySelector("dl")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches the admin coverage and lists stale members with their last-seen day", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => body }));
    vi.stubGlobal("fetch", fetcher);
    await import("./map-coverage.ts");
    const el = document.createElement("adminbot-map-coverage") as AdminBotMapCoverage;
    el.baseUrl = "http://adminbot.test/";
    el.sessionToken = "synthetic-session";
    document.body.append(el);
    await openPanel(el);
    await vi.waitFor(() => expect(el.querySelector("tbody tr")).not.toBeNull());
    expect(fetcher).toHaveBeenCalledWith(
      "http://adminbot.test/member-map/coverage",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer synthetic-session" }),
      }),
    );
    expect(el.querySelector('[data-bucket="suspected_vpn"] dd')?.textContent).toBe("1");
    expect(el.querySelector('[data-bucket="device"] dd')?.textContent).toBe("2");
    const row = el.querySelector('[data-member="m2"]')?.textContent?.replace(/\s+/g, " ");
    expect(row).toContain("stored city · Zürich · IP ignored (VPN?)");
  });

  it("shows an error rather than zeros when the request is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await import("./map-coverage.ts");
    const el = document.createElement("adminbot-map-coverage") as AdminBotMapCoverage;
    el.sessionToken = "synthetic-session";
    document.body.append(el);
    await openPanel(el);
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')).not.toBeNull());
    expect(el.querySelector("dl")).toBeNull();
  });
});
