// @vitest-environment happy-dom
import type { PaperWorkspaceProjection } from "@adminbot/api-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperClient } from "./paper-api-client.js";
import { AdminBotPaperWorkspace } from "./paper-workspace.js";

if (!customElements.get("adminbot-paper-workspace")) {
  customElements.define("adminbot-paper-workspace", AdminBotPaperWorkspace);
}

const workspace: PaperWorkspaceProjection = {
  viewerPersonId: "00000000-0000-4000-8000-000000000001",
  viewerRoles: ["administrator"],
  papers: [
    {
      paper: {
        id: "00000000-0000-4000-8000-000000000010",
        organizationId: "00000000-0000-4000-8000-000000000100",
        title: "Reliable agents",
        authorIds: ["00000000-0000-4000-8000-000000000001"],
        stage: "drafting",
        targetVenue: "NeurIPS",
        deadlineAt: "2026-08-29T11:59:00.000Z",
        topicTags: ["agents"],
        version: 2,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      },
      authorNames: ["Ada Admin"],
      timeline: {
        progressPercent: 20,
        totalEstimatedBusinessDays: 100,
        items: [{ stage: "drafting", label: "Drafting", durationBusinessDays: 25, offsetStartBusinessDay: 15, state: "current" }],
      },
    },
  ],
  nudges: [{ paperId: "00000000-0000-4000-8000-000000000010", title: "Reliable agents", stage: "drafting", kind: "author_nudge", message: "Deadline is approaching.", recipientIds: ["00000000-0000-4000-8000-000000000001"], recipientNames: ["Ada Admin"], dueAt: "2026-08-29T11:59:00.000Z" }],
};

describe("paper workspace", () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it("renders the Gantt, filters papers, and opens editing", async () => {
    const element = createWorkspace();
    document.body.append(element);
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Reliable agents"));
    expect(element.shadowRoot?.textContent).toContain("Reliable agents");
    expect(element.shadowRoot?.querySelector('[aria-label="Reliable agents timeline"]')).not.toBeNull();
    const search = element.shadowRoot?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error("missing paper search");
    search.value = "unmatched";
    search.dispatchEvent(new Event("input"));
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("No papers match these filters");
    search.value = "reliable";
    search.dispatchEvent(new Event("input"));
    await element.updateComplete;
    element.shadowRoot?.querySelector<HTMLButtonElement>(".paper-actions button")?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Edit Reliable agents");
  });

  it("confirms administrator deletion and refreshes", async () => {
    const client = fakeClient();
    const element = createWorkspace(client);
    document.body.append(element);
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("button.danger")).not.toBeNull());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    element.shadowRoot?.querySelector<HTMLButtonElement>("button.danger")?.click();
    await vi.waitFor(() => expect(client.delete).toHaveBeenCalledWith(workspace.papers[0]?.paper.id, { paperId: workspace.papers[0]?.paper.id, expectedVersion: 2 }));
    expect(client.list).toHaveBeenCalledTimes(2);
  });
});

function createWorkspace(client = fakeClient()): AdminBotPaperWorkspace {
  const element = document.createElement("adminbot-paper-workspace") as AdminBotPaperWorkspace;
  element.client = client;
  return element;
}

function fakeClient(): PaperClient & { list: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn().mockResolvedValue(workspace),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}
