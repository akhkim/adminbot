import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMemoryFailedRequestLedger,
  createSqliteFailedRequestLedger,
} from "./failed-requests.js";

describe("failed external request ledger", () => {
  it("records and lists in memory", () => {
    const ledger = createMemoryFailedRequestLedger();
    const row = ledger.record({
      serviceType: "dcs_form",
      payload: { email: "ada@example.com" },
      errorMessage: "timeout",
    });
    ledger.update(row.id, { status: "escalated_to_human" });
    expect(ledger.list()).toEqual([
      expect.objectContaining({
        id: row.id,
        service_type: "dcs_form",
        payload: { email: "ada@example.com" },
        status: "escalated_to_human",
      }),
    ]);
  });

  it("persists rows in sqlite", () => {
    const databasePath = path.join(mkdtempSync(path.join(tmpdir(), "adminbot-fail-")), "ledger.sqlite");
    const ledger = createSqliteFailedRequestLedger(databasePath);
    const saved = ledger.record({
      serviceType: "dcs_form",
      payload: { firstName: "Ada" },
      errorMessage: "hung",
    });
    expect(ledger.list()).toEqual([
      expect.objectContaining({ id: saved.id, payload: { firstName: "Ada" } }),
    ]);
  });
});
