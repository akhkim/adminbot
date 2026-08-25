import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeadlineProposalInput } from "../contracts/deadline-proposals.js";
import { createAdminBotSqliteService } from "./sqlite.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function input(): DeadlineProposalInput {
  return {
    name: "Persistent Workshop",
    parentConference: "ICLR",
    parentYear: "2027",
    entryType: "workshop",
    deadlineDate: "2026-11-05",
    deadlineTime: "23:59",
    timezone: "Etc/GMT+12",
    homepageUrl: "https://example.org/persistent/home",
    cfpUrl: "https://example.org/persistent/cfp",
    openReviewUrl: "",
    note: "",
  };
}

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

describe("SQLite deadline proposals", () => {
  it("preserves the queue, idempotency key, and published read model across restarts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-deadline-proposals-"));
    directories.push(directory);
    const databasePath = path.join(directory, "adminbot.sqlite");
    const first = createAdminBotSqliteService({ databasePath });
    const submitted = unwrap(
      first.service.submitDeadlineProposal(input(), "member-1", "persistent-submit-1"),
    );
    unwrap(
      await first.service.publishDeadlineProposal(submitted.id, submitted.payload_hash, {
        payload_hash: submitted.payload_hash,
        approver_role: "admin",
        approver_id: "admin-1",
      }),
    );
    first.close();

    const second = createAdminBotSqliteService({ databasePath });
    try {
      const replay = unwrap(
        second.service.submitDeadlineProposal(input(), "member-1", "persistent-submit-1"),
      );
      expect(replay.id).toBe(submitted.id);
      expect(unwrap(second.service.listDeadlineProposals()).proposals).toMatchObject([
        { id: submitted.id, status: "published" },
      ]);
      expect(second.service.deadlineReadModel([])).toMatchObject([
        { id: submitted.deadline_id, name: "Persistent Workshop" },
      ]);
    } finally {
      second.close();
    }
  });
});
