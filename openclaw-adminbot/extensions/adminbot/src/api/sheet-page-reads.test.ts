import { describe, expect, it, vi } from "vitest";
import { createSheetPageReads } from "./sheet-page-reads.js";

describe("createSheetPageReads", () => {
  it("shares one sheet read between page views", async () => {
    const reads = createSheetPageReads({ now: () => 0 });
    const load = vi.fn(async () => ({ rows: 3 }));
    await reads.memberSheet(load);
    await reads.memberSheet(load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reads again after a write to a sheet path, and not after a read", async () => {
    const reads = createSheetPageReads({ now: () => 0 });
    const load = vi.fn(async () => ({ rows: 3 }));
    await reads.memberSheet(load);
    reads.noteRequest("GET", "/membership/sheet");
    reads.noteRequest("POST", "/papers");
    await reads.memberSheet(load);
    expect(load).toHaveBeenCalledTimes(1);
    reads.noteRequest("POST", "/membership/sheet");
    await reads.memberSheet(load);
    expect(load).toHaveBeenCalledTimes(2);
    reads.noteRequest("POST", "/logistics/requests");
    await reads.memberSheet(load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("drops both views on invalidate, as an executed proposal does", async () => {
    const reads = createSheetPageReads({ now: () => 0 });
    const member = vi.fn(async () => ({ rows: 3 }));
    const call = vi.fn(async () => ({ queued: 1 }));
    await reads.memberSheet(member);
    await reads.callSheet(call, () => true);
    reads.invalidate();
    await reads.memberSheet(member);
    await reads.callSheet(call, () => true);
    expect(member).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("does not keep a call-queue answer that is an error", async () => {
    const reads = createSheetPageReads({ now: () => 0 });
    const call = vi.fn(async (): Promise<{ error?: string }> => ({ error: "no sheet" }));
    const keep = (value: { error?: string }) => !value.error;
    await reads.callSheet(call, keep);
    await reads.callSheet(call, keep);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("serves a stale view at once and refreshes it behind", async () => {
    let clock = 0;
    const reads = createSheetPageReads({ now: () => clock });
    let version = 1;
    const load = vi.fn(async () => ({ version }));
    expect(await reads.memberSheet(load)).toEqual({ version: 1 });
    clock = 2 * 60_000;
    version = 2;
    expect(await reads.memberSheet(load)).toEqual({ version: 1 });
    await Promise.resolve();
    expect(await reads.memberSheet(load)).toEqual({ version: 2 });
  });
});
