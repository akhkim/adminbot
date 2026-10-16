/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";

// The service refuses the ask. Mocked at the controller, because the question is what the panel
// does with a refusal, not how the refusal travels.
vi.mock("../controllers/lab-sharing.ts", () => ({
  askAdminBotLabSharingMember: vi.fn(async () => false),
  closeAdminBotLabSharingRequest: vi.fn(async () => true),
  loadAdminBotLabSharing: vi.fn(async () => undefined),
  offerAdminBotLabSharingHelp: vi.fn(async () => true),
  postAdminBotLabSharingRequest: vi.fn(async () => true),
  searchAdminBotLabSharingMembers: vi.fn(async () => undefined),
}));

const { renderLabSharing } = await import("./lab-sharing.ts");

it("un-marks a member as invited when the service refuses the ask", async () => {
  const state = {
    tab: "labSharing",
    labSharing: {
      projects: [{ id: "paper-demo", title: "Demo Planner" }],
      mine: [],
      open: [],
      invites: [],
    },
    labSharingSearchQuery: "sample",
    labSharingMembers: [
      {
        id: "m9",
        name: "Sam Sample",
        research_branch: "Example group",
        research_topics: [],
        matched_fields: ["name"],
        projects: [],
      },
    ],
  } as unknown as AppViewState;
  const container = document.createElement("div");
  document.body.append(container);
  const draw = () => render(renderLabSharing(state), container);
  (state as AppViewState & { requestUpdate?: () => void }).requestUpdate = draw;
  draw();

  container.querySelector<HTMLButtonElement>(".lab-sharing-member__invite")?.click();
  container.querySelector<HTMLButtonElement>('[data-testid="lab-sharing-ask-send"]')?.click();
  expect(state.labSharingInvitedMemberIds).toContain("m9");

  await vi.waitFor(() => expect(state.labSharingInvitedMemberIds).not.toContain("m9"));
  expect(container.querySelector(".lab-sharing-member__invite")?.textContent).toContain(
    "Invite to help",
  );
});
