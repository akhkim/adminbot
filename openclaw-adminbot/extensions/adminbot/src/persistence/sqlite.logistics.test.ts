import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLogisticsRequest } from "../contracts/actions.js";
import { AdminBotService } from "../kernel/service.js";
import { withoutAttachmentBytes } from "../workflows/logistics/requests.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function store(): AdminBotSqliteStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-logistics-"));
  dirs.push(dir);
  return new AdminBotSqliteStore(path.join(dir, "adminbot.sqlite"));
}

const file = (name: string, bytes?: string) => ({
  name,
  size: 3,
  content_type: "application/pdf",
  ...(bytes !== undefined ? { data_base64: bytes } : {}),
});

function requests(): AdminBotLogisticsRequest[] {
  const variants: Array<Partial<AdminBotLogisticsRequest>> = [
    { documents: [file("a.pdf", "QUFB"), file("b.pdf", "QkJC")] },
    { attachments: [file("c.pdf", "Q0ND")], documents: [file("d.pdf")] },
    { documents: [] },
    {},
    { documents: [file('ünïcødé "quoted" 😀.pdf', "RA==")], attachments: [] },
  ];
  return Array.from({ length: 15 }, (_, index) => ({
    id: `lr${index}`,
    kind: "document_signature",
    member_id: `m${index % 3}`,
    member_name: `Member ${index % 3}`,
    status: index % 4 ? "submitted" : "done",
    description: `please sign ${index} — ${1.5e-7 * index}`,
    // Ties on purpose, so the order among equal submission times is pinned too.
    submitted_at: `2026-04-0${(index % 5) + 1}T00:00:00.000Z`,
    updated_at: "2026-04-10T00:00:00.000Z",
    ...(index % 2 ? { deadline_at: `2026-05-0${(index % 7) + 1}T00:00:00.000Z` } : {}),
    ...variants[index % variants.length],
  })) as AdminBotLogisticsRequest[];
}

describe("listLogisticsRequestSummaries", () => {
  it("is the full read with the file bytes stripped, key order and row order included", () => {
    const sqlite = store();
    for (const request of requests()) {
      sqlite.saveLogisticsRequest(request);
    }
    for (const memberId of [undefined, "m1"]) {
      const summaries = sqlite.listLogisticsRequestSummaries(memberId);
      expect(JSON.stringify(summaries)).not.toContain("data_base64");
      expect(JSON.stringify(summaries.map(withoutAttachmentBytes))).toBe(
        JSON.stringify(sqlite.listLogisticsRequests(memberId).map(withoutAttachmentBytes)),
      );
    }
    // The full read still carries the bytes the single-request read serves.
    expect(JSON.stringify(sqlite.listLogisticsRequests())).toContain("QUFB");
    sqlite.close();
  });

  it("leaves the service's list payload unchanged", () => {
    const sqlite = store();
    for (const request of requests()) {
      sqlite.saveLogisticsRequest(request);
    }
    const service = new AdminBotService(sqlite);
    const viaSummaries = JSON.stringify([
      service.listLogisticsRequests(),
      service.listLogisticsRequests("m2"),
    ]);
    (sqlite as { listLogisticsRequestSummaries?: unknown }).listLogisticsRequestSummaries =
      undefined;
    const viaFullRead = JSON.stringify([
      service.listLogisticsRequests(),
      service.listLogisticsRequests("m2"),
    ]);
    expect(viaSummaries).toBe(viaFullRead);
    sqlite.close();
  });
});
