import { describe, expect, it, vi } from "vitest";
import { createInferenceGate, setSharedInferenceGate } from "../inference/gate.js";
import { openInferenceTestDb } from "../inference/gate.test-support.js";
import { createAdminBotMockService } from "./server.js";

describe("service inference lifetime", () => {
  it("injects its gate into host factories and drains before stopping HTTP", async () => {
    const db = openInferenceTestDb();
    const gate = createInferenceGate({ db });
    let finishDrain!: () => void;
    const shutdown = vi.spyOn(gate, "shutdown").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const reimbursementWorkflowFactory = vi.fn(() => ({
      converse: vi.fn(),
      generate: vi.fn(),
    }));
    const cvScanDepsFactory = vi.fn(() => ({
      now: () => new Date(),
      fetchPdf: vi.fn(),
      extractText: vi.fn(),
      extractEntries: vi.fn(),
    }));
    const service = createAdminBotMockService({
      inferenceGate: gate,
      calendarInviteRunner: async () => {},
      reimbursementWorkflowFactory,
      cvScanDepsFactory,
    });
    try {
      await service.listen(0);
      expect(reimbursementWorkflowFactory).toHaveBeenCalledWith(gate);
      expect(cvScanDepsFactory).toHaveBeenCalledWith(gate);
      const closed = service.close();
      expect(service.close()).toBe(closed);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(service.server.listening).toBe(true);
      finishDrain();
      await closed;
      expect(service.server.listening).toBe(false);
    } finally {
      finishDrain?.();
      await service.close();
      shutdown.mockRestore();
      await gate.shutdown();
      setSharedInferenceGate(undefined);
      db.close();
    }
  });
});
