import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("durably refuses another attempt after an uncertain effect", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const first = createCollaboratorChatRequestStore(db);
      expect(first.claimEffect("synthetic-action")).toBe(true);
      const reopened = createCollaboratorChatRequestStore(db);
      expect(reopened.claimEffect("synthetic-action")).toBe(false);
      expect(reopened.getEffect("synthetic-action")?.outcome).toBe("unknown");
      reopened.finishEffect("synthetic-action", {
        outcome: "message_unknown",
        slack_channel: "GEXAMPLE",
      });
      expect(first.getEffect("synthetic-action")?.slack_channel).toBe("GEXAMPLE");
    } finally {
      db.close();
    }
  });
  it("retains an uncertain attempt after closing and reopening the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "collaborator-chat-test-"));
    let db = new DatabaseSync(join(directory, "fixture.sqlite"));
    try {
      expect(createCollaboratorChatRequestStore(db).claimEffect("synthetic-action")).toBe(true);
      db.close();
      db = new DatabaseSync(join(directory, "fixture.sqlite"));
      const reopened = createCollaboratorChatRequestStore(db);
      expect(reopened.getEffect("synthetic-action")?.outcome).toBe("unknown");
      expect(reopened.claimEffect("synthetic-action")).toBe(false);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
