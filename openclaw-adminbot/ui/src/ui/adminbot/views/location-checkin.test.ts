/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckinBanner } from "../data/location-checkin.ts";
import { answerVia, renderLocationCheckin, type LocationCheckinProps } from "./location-checkin.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const CONFIRM: CheckinBanner = {
  checkin: { due: true, reason: "no_guess", suggestion: { city: "Toronto", source: "login" } },
  mode: "confirm",
};

function renderView(overrides: Partial<LocationCheckinProps> = {}) {
  const props: LocationCheckinProps = {
    banner: CONFIRM,
    onAnswer: vi.fn(),
    onChange: vi.fn(),
    onDevice: vi.fn(),
    onSnooze: vi.fn(),
    onDecline: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(renderLocationCheckin(props), container);
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { container, props, find };
}

describe("renderLocationCheckin", () => {
  it("renders nothing without a banner", () => {
    expect(renderView({ banner: null }).container.textContent?.trim()).toBe("");
  });

  it("asks one line with a one-tap Yes, and is a page region, not a dialog", () => {
    const { container, find, props } = renderView();
    expect(find("location-checkin-yes")).not.toBeNull();
    expect(container.textContent).toContain("Are you in Toronto?");
    expect(container.querySelector("[role=dialog], dialog")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(0);
    // No field to fill in before answering.
    expect(container.querySelector("input")).toBeNull();
    find("location-checkin-yes")!.click();
    expect(props.onAnswer).toHaveBeenCalledWith("Toronto", "picker");
  });

  it("keeps the picker behind 'No, change', and dismiss and decline one tap away", () => {
    const { find, props } = renderView();
    find("location-checkin-change")!.click();
    expect(props.onChange).toHaveBeenCalledOnce();
    find("location-checkin-dismiss")!.click();
    expect(props.onSnooze).toHaveBeenCalledOnce();
    find("location-checkin-decline")!.click();
    expect(props.onDecline).toHaveBeenCalledOnce();
  });

  it("puts the reason for asking on the question's tooltip, not in the copy", () => {
    const { container } = renderView({
      banner: {
        ...CONFIRM,
        checkin: {
          ...CONFIRM.checkin,
          note: "Toronto keeps a clock 6 hours from your Slack time zone.",
        },
      },
    });
    const question = container.querySelector(".location-checkin__question");
    expect(question?.getAttribute("title")).toContain("6 hours");
    expect(container.textContent).not.toContain("6 hours");
  });

  it("the picker takes a listed city or free text, and offers this device's location", () => {
    const places = [{ key: "berlin", label: "Berlin", country: "Germany", lat: 52.5, lon: 13.4 }];
    const { container, find, props } = renderView({
      banner: { ...CONFIRM, mode: "pick", places },
    });
    expect(container.querySelectorAll("datalist option")).toHaveLength(1);
    const input = find("location-checkin-city") as HTMLInputElement;
    // Empty after "No, change": the guess was wrong, so it is not left in the way.
    expect(input.value).toBe("");
    input.value = "berlin";
    container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(props.onAnswer).toHaveBeenLastCalledWith("berlin", "picker");
    input.value = "Smalltown";
    container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(props.onAnswer).toHaveBeenLastCalledWith("Smalltown", "text");
    find("location-checkin-device")!.click();
    expect(props.onDevice).toHaveBeenCalledOnce();
  });

  it("disables every control while a response is in flight, and shows an error inline", () => {
    const { container } = renderView({ banner: { ...CONFIRM, busy: "answer", error: "Nope" } });
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
    }
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Nope");
  });
});

describe("answerVia", () => {
  it("is 'picker' only for a listed city", () => {
    const places = [{ key: "toronto", label: "Toronto", country: "Canada", lat: 0, lon: 0 }];
    expect(answerVia(" toronto ", places)).toBe("picker");
    expect(answerVia("Toronto Island", places)).toBe("text");
    expect(answerVia("Toronto", undefined)).toBe("text");
  });
});
