/* @vitest-environment jsdom */
// Control UI tests cover the tab bar that multi-tab pages draw in place of extra sidebar entries.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPageTabs, renderTab } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { Tab } from "./navigation.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function createState(tab: Tab, setTab = vi.fn()) {
  return {
    tab,
    basePath: "",
    setTab,
    settings: { navCollapsed: false, navGroupsCollapsed: {} },
  } as unknown as AppViewState;
}

function draw(node: unknown) {
  const container = document.createElement("div");
  document.body.append(container);
  render(node as never, container);
  return container;
}

describe("renderPageTabs", () => {
  it("draws the sibling tabs of a page and marks the open one", () => {
    const container = draw(renderPageTabs(createState("adminbotWorkshopNudges"), "admin"));
    const tabs = [...container.querySelectorAll<HTMLAnchorElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Announcements",
      "Workshop Matches",
    ]);
    // Real links, so middle-click and the back button keep working.
    expect(tabs.map((tab) => tab.getAttribute("href"))).toEqual([
      "/adminbot/announcements",
      "/adminbot/workshop-nudges",
    ]);
    expect(tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toContain(
      "Workshop Matches",
    );
  });

  it("routes a click through setTab without leaving the page", () => {
    const setTab = vi.fn();
    const container = draw(renderPageTabs(createState("adminbotRegistrations", setTab), "admin"));
    const onboarding = [...container.querySelectorAll<HTMLAnchorElement>('[role="tab"]')].find(
      (tab) => tab.getAttribute("href") === "/adminbot/onboarding",
    );
    onboarding?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(setTab).toHaveBeenCalledWith("adminbotOnboarding");
  });

  it("puts the two halves of where the lab stands on one page", () => {
    const container = draw(renderPageTabs(createState("adminbotProfileOverview"), "admin"));
    const tabs = [...container.querySelectorAll<HTMLAnchorElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Active Papers",
      "Profile Completeness",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("href"))).toEqual([
      "/adminbot/papers",
      "/adminbot/profile-overview",
    ]);
  });

  it("draws nothing for a tab that stands alone", () => {
    expect(draw(renderPageTabs(createState("adminbotCalendar"), "admin")).textContent).toBe("");
    expect(draw(renderPageTabs(createState("dashboard"), "member")).textContent).toBe("");
  });

  it("draws nothing when the viewer may see only one of the siblings", () => {
    // Every membership sub-tab is admin-only, so a member is left with none and the bar would be
    // an empty rule across the page.
    expect(draw(renderPageTabs(createState("adminbotRegistrations"), "member")).textContent).toBe(
      "",
    );
  });
});

describe("the sidebar entry for a page", () => {
  it("names the page and stays lit while a sub-tab is open", () => {
    const container = draw(
      renderTab(createState("adminbotWorkshopNudges"), "adminbotAnnouncements"),
    );
    const link = container.querySelector("a");
    expect(link?.textContent?.trim()).toBe("Nudges");
    expect(link?.className).toContain("nav-item--active");
  });

  it("keeps its own name when it is the only tab on its page", () => {
    const container = draw(renderTab(createState("adminbotCalendar"), "adminbotCalendar"));
    expect(container.querySelector("a")?.textContent?.trim()).toBe("Calendar");
  });

  it("names the Lab Overview page rather than the papers tab it lands on", () => {
    const container = draw(renderTab(createState("adminbotProfileOverview"), "adminbotPapers"));
    const link = container.querySelector("a");
    expect(link?.textContent?.trim()).toBe("Lab Overview");
    expect(link?.className).toContain("nav-item--active");
  });
});
