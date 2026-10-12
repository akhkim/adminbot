// POST /papers/linkedin-draft with a PDF attached in the body.
//
// An attached PDF is the way through when the service cannot read the card's Drive copy, so the
// route has to take a real paper's worth of base64 -- well past the 1 MB default every other JSON
// route keeps.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkedInDraftRequest } from "../connectors/social-draft.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: Array<{ mock: ReturnType<typeof createAdminBotMockService>; cleanup: string }> = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    await rm(entry.cleanup, { force: true });
  }
});

async function start(): Promise<{ baseUrl: string; requests: LinkedInDraftRequest[] }> {
  const requests: LinkedInDraftRequest[] = [];
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-linkedin-draft-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    linkedInDraftRunner: async (request) => {
      requests.push(request);
      return {
        paper: { title: "A paper", authors: [], abstract: "An abstract." },
        text: "A draft.",
        model: "test/model",
        issues: [],
        authors: [],
      };
    },
    xDraftRunner: async (request) => {
      requests.push(request);
      return {
        paper: { title: "Paper", authors: [], abstract: "Evidence." },
        posts: [{ text: "1/2 Question" }, { text: "2/2 Finding" }],
        model: "test/model",
        issues: [],
        authors: [],
      };
    },
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
    throw new Error("missing service address");
  }
  running.push({ mock, cleanup: sensitiveInfoPath });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function draft(baseUrl: string, pdfBase64: string): Promise<number> {
  const res = await fetch(`${baseUrl}/papers/linkedin-draft`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pdf_base64: pdfBase64, paper_id: "p1" }),
  });
  await res.text();
  return res.status;
}

describe("POST /papers/linkedin-draft", () => {
  it("exposes a separate authenticated X draft endpoint", async () => {
    const { baseUrl, requests } = await start();
    const anonymous = await fetch(`${baseUrl}/papers/x-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);
    const response = await fetch(`${baseUrl}/papers/x-draft`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_base64: "cGRm" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      posts: [{ text: "1/2 Question" }, { text: "2/2 Finding" }],
    });
    expect(requests).toHaveLength(1);
  });
  it("takes an attached PDF far larger than the default JSON ceiling", async () => {
    const { baseUrl, requests } = await start();
    const pdfBase64 = Buffer.alloc(5 * 1024 * 1024, 1).toString("base64");

    expect(await draft(baseUrl, pdfBase64)).toBe(200);
    // The attached file is what reaches the model, not the card's Drive copy.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pdfBase64).toBe(pdfBase64);
  });

  it("still refuses a body past the 20 MB PDF ceiling", async () => {
    const { baseUrl, requests } = await start();
    const pdfBase64 = Buffer.alloc(21 * 1024 * 1024, 1).toString("base64");

    expect(await draft(baseUrl, pdfBase64)).toBe(413);
    expect(requests).toHaveLength(0);
  });
});
