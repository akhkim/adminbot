import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceCheckError, type ReferenceProgress } from "../connectors/reference-check.js";
import { GptZeroScanError } from "../connectors/reference-scan.js";
import { createAdminBotMockService } from "./server.js";

const token = "synthetic-service-token";
const instances: ReturnType<typeof createAdminBotMockService>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    if (instance.server.listening) {
      await new Promise<void>((resolve) => {
        instance.server.close(() => resolve());
      });
    }
    instance.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function setup(databasePath?: string, gptEnabled = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-reference-scans-"));
  dirs.push(dir);
  const scanPdf = vi.fn(
    async (
      _bytes: Uint8Array,
      _signal?: AbortSignal,
      _progress?: (event: ReferenceProgress) => void,
    ) => ({
      findings: [
        {
          citation: "Synthetic citation",
          status: "not_found" as const,
          explanation: "Synthetic finding",
        },
      ],
    }),
  );
  const scanGptZero = vi.fn(async (_bytes: Uint8Array) => ({
    provider_scan_id: "synthetic-scan",
    response_version: 1,
    citation_count: 3,
    uncertain_count: 1,
    findings: [],
  }));
  const db = databasePath ?? path.join(dir, "adminbot.sqlite");
  const app = createAdminBotMockService({
    databasePath: db,
    serviceToken: token,
    sensitiveInfoPath: path.join(dir, "sensitive.md"),
    pdfReferenceChecker: scanPdf,
    referenceScanDependencies: {
      readPdf: async () => {
        throw new Error("Manual checks must not read OpenReview");
      },
      scanPdf: gptEnabled ? scanGptZero : undefined,
    },
    calendarInviteRunner: async () => {},
  });
  instances.push(app);
  const base = await app.listen(0);
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no listening address");
  }
  const url = base.replace(":0", `:${address.port}`);
  return { app, url, db, scanPdf, scanGptZero };
}

function session(app: Awaited<ReturnType<typeof setup>>["app"], admin = true) {
  const memberId = admin ? "upload-admin" : "upload-member";
  const sessionToken = `${memberId}-session`;
  app.service.upsertLabMember({
    id: memberId,
    name: "Synthetic User",
    privilege_level: admin ? "admin" : "member",
  });
  app.store.saveSession({
    member_id: memberId,
    token_hash: createHash("sha256").update(sessionToken).digest("hex"),
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  return { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/pdf" };
}

describe("ad hoc PDF checks", () => {
  const endpoint = "/reference-check/pdf?consent=query-reference-databases";
  const pdf = "%PDF-synthetic-upload";

  it("checks the same PDF twice without persisting scans, proposals, or scan audits", async () => {
    const { app, url, scanPdf } = await setup();
    const headers = session(app);
    const saveProposal = vi.spyOn(app.store, "saveProposal");
    const audit = vi.spyOn(app.store, "recordAudit");
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url + endpoint, { method: "POST", headers, body: pdf });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).findings).toHaveLength(1);
    }
    expect(scanPdf).toHaveBeenCalledTimes(2);
    expect(Buffer.from(scanPdf.mock.calls[0]?.[0] ?? []).toString()).toBe(pdf);
    expect(saveProposal).not.toHaveBeenCalled();
    expect(
      audit.mock.calls.filter(([event]) => /proposal|execution|reference/u.test(event.type)),
    ).toHaveLength(0);
  });

  it("routes repeated GPTZero uploads only to GPTZero without persisting proposals or audits", async () => {
    const { app, url, scanPdf, scanGptZero } = await setup();
    const headers = session(app);
    const saveProposal = vi.spyOn(app.store, "saveProposal");
    const audit = vi.spyOn(app.store, "recordAudit");
    const target = url + "/reference-check/pdf?checker=gptzero&consent=upload-to-gptzero";
    for (let i = 0; i < 2; i++) {
      const response = await fetch(target, { method: "POST", headers, body: pdf });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        checker: "gptzero",
        citation_count: 3,
        uncertain_count: 1,
        findings: [],
      });
    }
    expect(scanGptZero).toHaveBeenCalledTimes(2);
    expect(Buffer.from(scanGptZero.mock.calls[0][0]).toString()).toBe(pdf);
    expect(scanPdf).not.toHaveBeenCalled();
    expect(saveProposal).not.toHaveBeenCalled();
    expect(
      audit.mock.calls.filter(([event]) => /proposal|execution|reference/u.test(event.type)),
    ).toHaveLength(0);
    scanGptZero.mockRejectedValueOnce(new GptZeroScanError(403));
    const failed = await fetch(target, { method: "POST", headers, body: pdf });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.message).toContain("HTTP 403");
    expect(scanPdf).not.toHaveBeenCalled();
  });

  it("rejects unknown checkers, mismatched consent and missing GPTZero configuration", async () => {
    const { app, url, scanPdf, scanGptZero } = await setup(undefined, false);
    const headers = session(app);
    for (const [query, status] of [
      ["checker=unknown&consent=query-reference-databases", 400],
      ["checker=gptzero&consent=query-reference-databases", 400],
      ["checker=references-validation&consent=upload-to-gptzero", 400],
      ["checker=gptzero&consent=upload-to-gptzero", 503],
    ] as const) {
      expect(
        (await fetch(url + "/reference-check/pdf?" + query, { method: "POST", headers, body: pdf }))
          .status,
      ).toBe(status);
    }
    expect(scanPdf).not.toHaveBeenCalled();
    expect(scanGptZero).not.toHaveBeenCalled();
    expect(
      (
        await fetch(url + endpoint + "&checker=references-validation", {
          method: "POST",
          headers,
          body: pdf,
        })
      ).status,
    ).toBe(200);
    expect(scanPdf).toHaveBeenCalledOnce();
  });

  it("streams findings before completion and reports errors after headers without leaking details", async () => {
    const { app, url, scanPdf } = await setup();
    const headers = { ...session(app), Accept: "application/x-ndjson" };
    const saveProposal = vi.spyOn(app.store, "saveProposal");
    const finding = {
      citation: "Early citation",
      status: "not_found" as const,
      explanation: "Not found",
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scanPdf.mockImplementationOnce(async (_bytes, _signal, progress) => {
      progress?.({ completed: 0, total: 2 });
      progress?.({ completed: 1, total: 2, finding });
      await gate;
      throw new Error("private manuscript provider details");
    });
    const response = await fetch(url + endpoint, { method: "POST", headers, body: pdf });
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const reader = response.body!.getReader();
    let output = "";
    try {
      while (!output.includes("Early citation")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        output += new TextDecoder().decode(chunk.value);
      }
      expect(output).not.toContain('"type":"complete"');
    } finally {
      release();
    }
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += new TextDecoder().decode(chunk.value);
    }
    expect(output).toContain('"type":"error"');
    expect(output).not.toContain("private manuscript");
    expect(saveProposal).not.toHaveBeenCalled();
    const retry = await fetch(url + endpoint, { method: "POST", headers, body: pdf });
    expect(await retry.text()).toContain('"type":"complete"');
  });

  it("rejects anonymous, ordinary member, service-token and unapproved uploads", async () => {
    const { app, url, scanPdf } = await setup();
    for (const [headers, status] of [
      [{ "Content-Type": "application/pdf" }, 401],
      [session(app, false), 403],
      [{ Authorization: `Bearer ${token}`, "Content-Type": "application/pdf" }, 403],
    ] as const) {
      expect((await fetch(url + endpoint, { method: "POST", headers, body: pdf })).status).toBe(
        status,
      );
    }
    expect(
      (
        await fetch(url + "/reference-check/pdf", {
          method: "POST",
          headers: session(app),
          body: pdf,
        })
      ).status,
    ).toBe(400);
    expect(scanPdf).not.toHaveBeenCalled();
  });

  it("rejects invalid, oversized and cross-origin uploads before scanning", async () => {
    const { app, url, scanPdf } = await setup();
    const headers = session(app);
    for (const body of ["", "not a pdf"]) {
      expect((await fetch(url + endpoint, { method: "POST", headers, body })).status).toBe(415);
    }
    expect(
      (
        await fetch(url + endpoint, {
          method: "POST",
          headers: { ...headers, "Content-Type": "text/plain" },
          body: pdf,
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(url + endpoint, {
          method: "POST",
          headers,
          body: new Uint8Array(20 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(url + endpoint, {
          method: "POST",
          headers: { ...headers, Origin: "https://untrusted.example" },
          body: pdf,
        })
      ).status,
    ).toBe(403);
    expect(scanPdf).not.toHaveBeenCalled();
  });

  it("does not leak provider failures and permits retry after failure", async () => {
    const { app, url, scanPdf } = await setup();
    const headers = session(app);
    scanPdf.mockRejectedValueOnce(new Error("private provider payload"));
    const failed = await fetch(url + endpoint, { method: "POST", headers, body: pdf });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("private provider payload");
    scanPdf.mockRejectedValueOnce(new ReferenceCheckError("No bibliography found."));
    const unreadable = await fetch(url + endpoint, { method: "POST", headers, body: pdf });
    expect(unreadable.status).toBe(422);
    expect(await unreadable.json()).toEqual({ error: { message: "No bibliography found." } });
    expect((await fetch(url + endpoint, { method: "POST", headers, body: pdf })).status).toBe(200);
  });

  it("rejects concurrent checks and releases the guard when the scan finishes", async () => {
    const { app, url, scanPdf } = await setup();
    const headers = session(app);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = await scanPdf(Buffer.from(pdf));
    scanPdf.mockClear();
    scanPdf.mockImplementationOnce(async () => {
      await gate;
      return value;
    });
    const first = fetch(url + endpoint, { method: "POST", headers, body: pdf });
    await vi.waitFor(() => expect(scanPdf).toHaveBeenCalledOnce());
    try {
      expect((await fetch(url + endpoint, { method: "POST", headers, body: pdf })).status).toBe(
        429,
      );
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
    expect((await fetch(url + endpoint, { method: "POST", headers, body: pdf })).status).toBe(200);
  });
});
