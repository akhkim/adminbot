import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotCvEntry, AdminBotLabMemberInput } from "../contracts/actions.js";
import type { AdminBotCvScanDeps } from "../cv-scan.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: ReturnType<typeof createAdminBotMockService>[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop();
    if (!mock) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
});

async function startService(options: Parameters<typeof createAdminBotMockService>[0] = {}) {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath: path.join(
      os.tmpdir(),
      `adminbot-cv-digest-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    ),
    ...options,
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", () => {
      mock.server.off("error", reject);
      resolve();
    });
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  running.push(mock);
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" };
}

// A scan that always "reads" one entry off whatever CV it is pointed at, so the route can be
// exercised without a network fetch, a python interpreter, or a running model.
function stubScanDeps(entries: AdminBotCvEntry[]): AdminBotCvScanDeps {
  return {
    fetchPdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    extractText: async () => ({ ok: true, text: entries.map((entry) => entry.title).join("\n") }),
    extractEntries: async () => entries,
    now: () => new Date("2026-08-20T09:00:00.000Z"),
  };
}

const MEMBER: AdminBotLabMemberInput = {
  id: "m-jane",
  name: "Jane Doe",
  privilege_level: "member",
  cv_url: "https://example.com/jane.pdf",
};

const RECENT_POSITION: AdminBotCvEntry = {
  kind: "position",
  title: "Research Scientist",
  organization: "NVIDIA",
  start: "2026-07",
  start_iso: "2026-07",
};

// Seeded through the service rather than over HTTP: creating a roster member needs a real admin
// *member* session, which this suite has no reason to stand up just to give the scan something
// with a cv_url to read.
function seedMember(
  mock: ReturnType<typeof createAdminBotMockService>,
  member: AdminBotLabMemberInput = MEMBER,
) {
  const result = mock.service.upsertLabMember(member);
  expect(result.ok).toBe(true);
}

describe("POST /cv/publish-digest", () => {
  it("refuses an unauthenticated caller", async () => {
    const { baseUrl } = await startService();
    const response = await fetch(`${baseUrl}/cv/publish-digest`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  // The document id is deploy config, so a service without one has no job at all rather than a
  // button that fails inside the gog CLI.
  it("answers 503 naming the variable when no document is configured", async () => {
    const { baseUrl } = await startService({ cvScanDeps: stubScanDeps([RECENT_POSITION]) });
    const response = await fetch(`${baseUrl}/cv/publish-digest`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("ADMINBOT_CV_DIGEST_DOC_ID");
  });

  it("scans, publishes the rendered document, and reports what it wrote", async () => {
    const publish = vi.fn(async () => {});
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([RECENT_POSITION]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish },
    });
    seedMember(mock);

    const response = await fetch(`${baseUrl}/cv/publish-digest`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      document_url: string;
      day_count: number;
      change_count: number;
    };
    expect(body.document_url).toBe("https://docs.example/doc");
    expect(body.change_count).toBe(1);
    expect(body.day_count).toBe(1);

    expect(publish).toHaveBeenCalledTimes(1);
    const markdown = publish.mock.calls[0]?.[0] as unknown as string;
    expect(markdown).toContain("# CV Updates");
    expect(markdown).toContain("Jane Doe");
    expect(markdown).toContain("NVIDIA");
  });

  // The whole reason the document renders from the ledger rather than from the scan: a scan
  // consumes its own diff, so the second run finds nothing and a scan-shaped document would go
  // blank. The published body must still carry the change the first run recorded.
  it("keeps publishing earlier changes when a later scan finds nothing new", async () => {
    const publish = vi.fn(async () => {});
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([RECENT_POSITION]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish },
    });
    seedMember(mock);

    await fetch(`${baseUrl}/cv/publish-digest`, { method: "POST", headers: headers() });
    const second = await fetch(`${baseUrl}/cv/publish-digest`, {
      method: "POST",
      headers: headers(),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { change_count: number };
    expect(body.change_count).toBe(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0] as unknown as string).toContain("NVIDIA");
  });

  it("reports a failed write as 502 and does not claim the document changed", async () => {
    const publish = vi.fn(async () => {
      throw new Error("gog exited with code 1");
    });
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([RECENT_POSITION]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish },
    });
    seedMember(mock);

    const response = await fetch(`${baseUrl}/cv/publish-digest`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("gog exited with code 1");

    const audit = await fetch(`${baseUrl}/audit`, { headers: headers() });
    const events = (await audit.json()) as { events: Array<{ type: string }> };
    expect(events.events.some((event) => event.type === "cv.digest_failed")).toBe(true);
    expect(events.events.some((event) => event.type === "cv.digest_published")).toBe(false);
  });

  it("records who published, and what, on the audit ledger", async () => {
    const { baseUrl, mock } = await startService({
      cvScanDeps: stubScanDeps([RECENT_POSITION]),
      cvDigestPublisher: { documentUrl: "https://docs.example/doc", publish: async () => {} },
    });
    seedMember(mock);
    await fetch(`${baseUrl}/cv/publish-digest`, { method: "POST", headers: headers() });

    const audit = await fetch(`${baseUrl}/audit`, { headers: headers() });
    const events = (await audit.json()) as {
      events: Array<{ type: string; actor?: string; details?: Record<string, unknown> }>;
    };
    const published = events.events.find((event) => event.type === "cv.digest_published");
    expect(published).toBeDefined();
    expect(published?.details?.document_url).toBe("https://docs.example/doc");
    expect(published?.details?.change_count).toBe(1);
  });
});
