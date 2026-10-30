import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createCollaboratorChatRequestStore } from "./collaborator-chat-requests.js";

describe("collaborator-chat saved intentions", () => {
  it("persists a request without requiring Slack identities and isolates owners", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = createCollaboratorChatRequestStore(db);
      const saved = store.save("owner-a", {
        context: "Synthetic research discussion",
        participant_ids: ["member-a", "member-b"],
      });
      expect(createCollaboratorChatRequestStore(db).list("owner-a")).toEqual([saved]);
      expect(
        store.save("owner-a", {
          context: "Synthetic research discussion",
          participant_ids: ["member-b", "member-a"],
        }),
      ).toEqual(saved);
      expect(store.list("owner-b")).toEqual([]);
    } finally {
      db.close();
    }
  });
  it("rejects incomplete context and duplicate participants without persisting them", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = createCollaboratorChatRequestStore(db);
      expect(() => store.save("owner", { context: "", participant_ids: ["a", "b"] })).toThrow();
      expect(() =>
        store.save("owner", { context: "Discuss", participant_ids: ["a", "a"] }),
      ).toThrow();
      expect(store.list("owner")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
