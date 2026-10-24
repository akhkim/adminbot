import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./server.js";

// Production passes a databasePath, which routes construction through createAdminBotSqliteService.
// That factory used to forward only three options, so the runtime dataset reader was dropped there
// while the in-memory path kept it -- and every other /deadlines test runs in memory. Both paths
// are exercised here so the two cannot drift apart again unnoticed.
const BACKENDS = [
  { name: "in-memory", durable: false },
  { name: "sqlite", durable: true },
] as const;

let dir: string;
let datasetPath: string;
let previousDatasetPath: string | undefined;
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

function writeDataset(checkedAt: string) {
  writeFileSync(
    datasetPath,
    JSON.stringify({
      items: [
        {
          id: "synthconf2099_paper",
          name: "SynthConf 2099",
          venue_type: "conference",
          deadline_aoe: "2099-01-15 23:59:59",
          source_checked_at: checkedAt,
        },
      ],
    }),
  );
}

async function readDeadlines(durable: boolean) {
  const mock = createAdminBotMockService(
    durable ? { databasePath: join(dir, "adminbot.sqlite") } : {},
  );
  running.push(mock);
  // listen() echoes the requested port back, so with 0 the bound one has to be read off the socket.
  await mock.listen(0);
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/deadlines`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: Array<Record<string, unknown>> }).items;
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adminbot-deadline-dataset-"));
  datasetPath = join(dir, "deadlines.json");
  previousDatasetPath = process.env.ADMINBOT_DEADLINE_DATASET_PATH;
  process.env.ADMINBOT_DEADLINE_DATASET_PATH = datasetPath;
});

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop()!;
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
  if (previousDatasetPath === undefined) {
    delete process.env.ADMINBOT_DEADLINE_DATASET_PATH;
  } else {
    process.env.ADMINBOT_DEADLINE_DATASET_PATH = previousDatasetPath;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.each(BACKENDS)("GET /deadlines ($name)", ({ durable }) => {
  it("serves the collected dataset file and picks up a re-collection without a restart", async () => {
    writeDataset("2099-01-01T00:00:00Z");
    const read = await readDeadlines(durable);

    expect(await read()).toEqual([
      expect.objectContaining({
        id: "synthconf2099_paper",
        source_checked_at: "2099-01-01T00:00:00Z",
      }),
    ]);

    writeDataset("2099-01-02T00:00:00Z");
    expect((await read())[0]).toMatchObject({ source_checked_at: "2099-01-02T00:00:00Z" });
  });

  it("falls back to the compiled snapshot when the dataset file is unreadable", async () => {
    // No file written: the read throws, and the board must still get dates rather than a 500.
    const read = await readDeadlines(durable);

    const items = await read();
    expect(items.length).toBeGreaterThan(1);
    expect(items.map((item) => item.id)).not.toContain("synthconf2099_paper");
  });
});
