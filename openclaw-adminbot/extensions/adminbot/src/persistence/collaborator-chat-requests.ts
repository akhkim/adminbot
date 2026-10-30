import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CollaboratorChatRequest = {
  id: string;
  owner_id: string;
  context: string;
  participant_ids: string[];
  created_at: string;
};

/** Saved intentions only. Approval and Slack receipts must live in the execution ledger. */
export function createCollaboratorChatRequestStore(db?: DatabaseSync) {
  const effects = new Map<string, Record<string, string>>();
  db?.exec(`CREATE TABLE IF NOT EXISTS adminbot_collaborator_chat_effects (
    action_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL)`);
  const getEffect = (id: string): Record<string, string> | undefined => {
    if (!db) {
      return effects.get(id);
    }
    const row = db
      .prepare("SELECT receipt_json FROM adminbot_collaborator_chat_effects WHERE action_id = ?")
      .get(id);
    return row ? JSON.parse(String(row.receipt_json)) : undefined;
  };
  const memory = new Map<string, CollaboratorChatRequest>();
  db?.exec(`CREATE TABLE IF NOT EXISTS adminbot_collaborator_chat_requests (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, context TEXT NOT NULL,
    participant_ids TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const insert = db?.prepare(
    "INSERT OR IGNORE INTO adminbot_collaborator_chat_requests VALUES (?, ?, ?, ?, ?)",
  );
  const select = db?.prepare(
    "SELECT * FROM adminbot_collaborator_chat_requests WHERE owner_id = ? ORDER BY created_at, id",
  );
  return {
    getEffect,
    claimEffect(id: string): boolean {
      if (db) {
        return (
          Number(
            db
              .prepare("INSERT OR IGNORE INTO adminbot_collaborator_chat_effects VALUES (?, ?)")
              .run(
                id,
                JSON.stringify({
                  outcome: "unknown",
                  detail: "Execution started; reconcile before retrying.",
                }),
              ).changes,
          ) === 1
        );
      }
      if (effects.has(id)) {
        return false;
      }
      effects.set(id, { outcome: "unknown" });
      return true;
    },
    finishEffect(id: string, receipt: Record<string, string>) {
      if (db) {
        db.prepare(
          "UPDATE adminbot_collaborator_chat_effects SET receipt_json = ? WHERE action_id = ?",
        ).run(JSON.stringify(receipt), id);
      } else {
        effects.set(id, receipt);
      }
    },
    save(
      ownerId: string,
      input: { context: string; participant_ids: string[] },
    ): CollaboratorChatRequest {
      if (!ownerId.trim() || !input.context.trim() || input.context.length > 2000) {
        throw new Error("Provide an owner and a context of at most 2,000 characters.");
      }
      const ids = input.participant_ids;
      if (
        ids.length < 2 ||
        ids.length > 8 ||
        ids.some((id) => !id.trim()) ||
        new Set(ids).size !== ids.length
      ) {
        throw new Error("Choose between two and eight distinct members.");
      }
      const request = {
        id: createHash("sha256")
          .update(JSON.stringify([ownerId, input.context.trim(), [...ids].toSorted()]))
          .digest("hex"),
        owner_id: ownerId,
        context: input.context.trim(),
        participant_ids: [...ids],
        created_at: new Date().toISOString(),
      };
      const previous =
        memory.get(request.id) ??
        (db ? select!.all(ownerId).find((r) => r.id === request.id) : undefined);
      if (previous) {
        return this.list(ownerId).find((r) => r.id === request.id)!;
      }
      insert?.run(request.id, ownerId, request.context, JSON.stringify(ids), request.created_at);
      memory.set(request.id, request);
      return request;
    },
    list(ownerId: string): CollaboratorChatRequest[] {
      if (!select) {
        return [...memory.values()]
          .filter((r) => r.owner_id === ownerId)
          .map((r) => structuredClone(r));
      }
      return select.all(ownerId).map((row) => ({
        id: String(row.id),
        owner_id: String(row.owner_id),
        context: String(row.context),
        participant_ids: JSON.parse(String(row.participant_ids)) as string[],
        created_at: String(row.created_at),
      }));
    },
  };
}
