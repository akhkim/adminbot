import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaboratorChats } from "./collaborator-chats.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mounted() {
  const element = new CollaboratorChats();
  element.baseUrl = "http://127.0.0.1:8765";
  element.sessionToken = "synthetic-session";
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("collaborator chat requests", () => {
  it("saves only the selected members and context, with no chat-creation request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          members: [
            { id: "ada", name: "Ada Example" },
            { id: "bea", name: "Bea Example" },
          ],
          requests: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          request: {
            id: "request-1",
            context: "Synthetic project",
            participant_ids: ["ada", "bea"],
          },
          message: "Saved only.",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const element = await mounted();
    (element.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(element.querySelectorAll("option")).toHaveLength(2));
    for (const option of element.querySelectorAll("option")) {option.selected = true;}
    element.querySelector("select")!.dispatchEvent(new Event("change"));
    const text = element.querySelector("textarea")!;
    text.value = "Synthetic project";
    text.dispatchEvent(new Event("input"));
    await element.updateComplete;
    (element.querySelectorAll("button")[1] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(element.textContent).toContain("Saved only."));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:8765/collaborator-chats");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      context: "Synthetic project",
      participant_ids: ["ada", "bea"],
    });
    expect(element.textContent).toContain("Saving does not create a Slack chat");
  });
  it("does not carry a previous session's participants into another session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ members: [{ id: "ada", name: "Ada Example" }], requests: [] }),
        }),
    );
    const element = await mounted();
    (element.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(element.querySelectorAll("option")).toHaveLength(1));
    element.sessionToken = "different-synthetic-session";
    await element.updateComplete;
    expect(element.querySelectorAll("option")).toHaveLength(0);
  });
});
