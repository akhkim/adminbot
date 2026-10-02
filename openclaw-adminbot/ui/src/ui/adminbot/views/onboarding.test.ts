/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import { renderAdminBotOnboarding } from "./onboarding.ts";

function renderView(overrides: Partial<AppViewState> = {}) {
  const state = { tab: "adminbotOnboarding", ...overrides } as unknown as AppViewState;
  const container = document.createElement("div");
  document.body.append(container);
  render(renderAdminBotOnboarding(state), container);
  return container;
}

describe("renderAdminBotOnboarding", () => {
  it("is the member roster", () => {
    const container = renderView({
      memberSheet: {
        spreadsheet_id: "sheet-1",
        tab: "Full Slack Member List",
        url: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
        header: ["Name", "Member Type"],
        rows: [{ sheet_row: 2, cells: ["Ada Lovelace", "full"] }],
        read_at: "2026-08-30T00:00:00.000Z",
      },
    });
    expect(container.querySelector<HTMLInputElement>("table input")).not.toBeNull();
    expect(container.textContent).toContain("Member roster");
  });

  // Every field the old form asked for is a column on the row beside it, so asking again only
  // invited the two to disagree about who was being onboarded.
  it("no longer asks for a name, an address or a template the sheet already carries", () => {
    const container = renderView();
    expect(container.querySelector('input[name="name"]')).toBeNull();
    expect(container.querySelector('input[name="email"]')).toBeNull();
    expect(container.querySelector('select[name="templateId"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-send"]')).toBeNull();
  });
});
