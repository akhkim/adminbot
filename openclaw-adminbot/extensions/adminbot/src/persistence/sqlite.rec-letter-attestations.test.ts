import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotRecLetterAttestation } from "../contracts/rec-letter-attestations.js";
import { AdminBotMemoryStore } from "./memory.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-attestations-"));
  dirs.push(dir);
  return path.join(dir, "adminbot.sqlite");
}

function attestation(
  id: string,
  memberId: string,
  createdAt: string,
  extra: Partial<AdminBotRecLetterAttestation> = {},
): AdminBotRecLetterAttestation {
  return {
    id,
    member_id: memberId,
    criterion: "hours",
    created_by: "admin:m-admin",
    created_at: createdAt,
    ...extra,
  };
}

describe("recommendation-letter attestations on SQLite", () => {
  it("lists newest first, per member or all, and survives a reopen", () => {
    const file = tempFile();
    const store = new AdminBotSqliteStore(file);
    store.saveRecLetterAttestation(attestation("a1", "m-alpha", "2026-03-01T12:00:00.000Z"));
    store.saveRecLetterAttestation(
      attestation("a2", "m-alpha", "2026-09-01T12:00:00.000Z", {
        criterion: "attendance",
        note: "synthetic note",
      }),
    );
    store.saveRecLetterAttestation(attestation("a3", "m-beta", "2026-05-01T12:00:00.000Z"));
    store.close();

    const reopened = new AdminBotSqliteStore(file);
    expect(reopened.listRecLetterAttestations().map((row) => row.id)).toEqual(["a2", "a3", "a1"]);
    const alpha = reopened.listRecLetterAttestations("m-alpha");
    expect(alpha.map((row) => row.id)).toEqual(["a2", "a1"]);
    expect(alpha[0]).toMatchObject({ criterion: "attendance", note: "synthetic note" });
    expect(reopened.listRecLetterAttestations("m-nobody")).toEqual([]);
    reopened.close();
  });

  it("upserts by id and deletes once, like the in-memory store", () => {
    for (const store of [new AdminBotSqliteStore(tempFile()), new AdminBotMemoryStore()]) {
      store.saveRecLetterAttestation(attestation("a1", "m-alpha", "2026-03-01T12:00:00.000Z"));
      store.saveRecLetterAttestation(
        attestation("a1", "m-alpha", "2026-03-01T12:00:00.000Z", { note: "edited" }),
      );
      expect(store.listRecLetterAttestations()).toHaveLength(1);
      expect(store.listRecLetterAttestations()[0]?.note).toBe("edited");
      expect(store.deleteRecLetterAttestation("a1")).toBe(true);
      expect(store.deleteRecLetterAttestation("a1")).toBe(false);
      expect(store.listRecLetterAttestations()).toEqual([]);
      if (store instanceof AdminBotSqliteStore) {
        store.close();
      }
    }
  });
});
