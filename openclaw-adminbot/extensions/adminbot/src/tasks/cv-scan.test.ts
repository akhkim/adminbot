import { expect, it, vi } from "vitest";
import { createAdminBotMockService } from "../api/server.js";

it("commits a CV snapshot with its change ledger and checkpoint, and retries a rolled-back commit", async () => {
  let extracts = 0;
  const app = createAdminBotMockService({
    databasePath: ":memory:",
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
    cvScanDeps: {
      now: () => new Date(),
      fetchPdf: async () => new Uint8Array([1]),
      extractText: async () => ({ ok: true, text: "Synthetic CV" }),
      extractEntries: async () => {
        extracts++;
        return [
          {
            kind: "position",
            title: "Researcher",
            organization: "Example",
            start: "Current month",
            start_iso: new Date().toISOString().slice(0, 7),
          },
        ];
      },
    },
  });
  try {
    const saved = app.service.upsertLabMember({
      id: "synthetic",
      name: "Synthetic Member",
      email: "synthetic@example.invalid",
      privilege_level: "member",
      cv_url: "https://example.invalid/cv.pdf",
    });
    expect(saved.ok).toBe(true);
    const ledger = vi.spyOn(app.store, "recordCvChanges").mockImplementationOnce(() => {
      throw new Error("ledger write failed");
    });
    const submitted = app.taskRuntime.submit({
      owner: "service",
      kind: "cv.scan",
      input: {},
      wait: true,
    });
    expect((await submitted.promise)?.status).toBe("failed");
    expect(app.store.getLabMember("synthetic")?.cv_snapshot).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const retried = app.taskRuntime.retry(submitted.id, "service")!;
    const result = await retried.promise;
    expect(result?.status).toBe("completed");
    expect(app.store.getLabMember("synthetic")?.cv_snapshot?.entries).toHaveLength(1);
    expect(extracts).toBe(1);
    expect(ledger).toHaveBeenCalledTimes(2);
    expect(app.store.listCvChangesSince("2020-01-01T00:00:00.000Z")).toHaveLength(1);
  } finally {
    await app.close();
  }
});
