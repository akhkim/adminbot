/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { LabMember } from "../auth/session.ts";
import { renderPreciseLocation } from "./precise-location.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");

function mount(
  member: Partial<LabMember> | null,
  state?: Parameters<typeof renderPreciseLocation>[0]["state"],
) {
  const host = document.createElement("div");
  const onUse = vi.fn();
  render(
    renderPreciseLocation({
      member: member ? ({ id: "m_synthetic", ...member } as LabMember) : null,
      state,
      now: NOW,
      onUse,
    }),
    host,
  );
  return { host, onUse };
}

describe("renderPreciseLocation", () => {
  it("renders nothing for a hidden or stated member", () => {
    expect(mount({ map_visibility: "hidden" }).host.textContent?.trim()).toBe("");
    expect(mount({ map_visibility: "stated" }).host.textContent?.trim()).toBe("");
    expect(mount(null).host.textContent?.trim()).toBe("");
  });

  it("offers the button with a Why? when no device city is fresh", () => {
    const { host, onUse } = mount({
      device_city: "Synthville",
      device_located_at: "2026-10-01T00:00:00Z",
    });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="precise-location-use"]')!;
    expect(button.textContent?.trim()).toBe("Use my precise location");
    expect(host.querySelector("details summary")?.textContent).toBe("Why?");
    expect(host.querySelector('[data-testid="precise-location-note"]')).toBeNull();
    button.click();
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it("confirms inline once a device city is known: 📍 City · Change", () => {
    const fromRecord = mount({
      device_city: "Synthville",
      device_located_at: "2026-10-15T00:00:00Z",
    });
    expect(fromRecord.host.textContent?.replace(/\s+/gu, " ").trim()).toBe(
      "📍 Synthville · Change",
    );
    const fromSession = mount({}, { place: { city: "Reggio Emilia" } });
    expect(
      fromSession.host.querySelector('[data-testid="precise-location-city"]')?.textContent,
    ).toBe("📍 Reggio Emilia");
    fromSession.host
      .querySelector<HTMLButtonElement>('[data-testid="precise-location-change"]')!
      .click();
    expect(fromSession.onUse).toHaveBeenCalledTimes(1);
  });

  it("shows a short note only after a press came back empty", () => {
    const { host } = mount({}, { note: "denied" });
    expect(host.querySelector('[data-testid="precise-location-note"]')?.textContent).toBe(
      "Location is off for this site in your browser.",
    );
    expect(host.querySelector('[role="alert"], .callout, .toast')).toBeNull();
  });
});
